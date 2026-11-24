"""本家（kouchou-ai の analysis-core）を実際に動かして、適合性テストの期待値を作る。

使い方:
    python conformance/generate_expected.py --kouchou-ai ../kouchou-ai

- LLM 呼び出しは conformance/fake_llm.py の偽 LLM に差し替える（ネットワークに出ない）
- 埋め込みと UMAP は実装ごとに乱数が違って一致しないので、座標とクラスタの割り当ては
  ケースから決まった規則で作り、本家・serverless の両方に同じものを入力として渡す
- 出力は conformance/expected/ に書く。TypeScript 側（tests/conformance/）がこれを読んで比べる
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import math
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import fake_llm  # noqa: E402

PROMPT_FILES = {
    "extraction": "extractionPrompt.ts",
    "initial_labelling": "initialLabellingPrompt.ts",
    "merge_labelling": "mergeLabellingPrompt.ts",
    "overview": "overviewPrompt.ts",
}


def read_admin_prompts(kouchou_ai: Path) -> dict[str, str]:
    """管理画面（Web UI）が analysis-core に渡すプロンプトを、本家の TS ファイルから読む。"""
    prompts = {}
    for stage, name in PROMPT_FILES.items():
        text = (kouchou_ai / "apps/admin/app/create" / name).read_text(encoding="utf-8")
        literals = re.findall(r"`([^`]*)`", text, re.S)
        if len(literals) != 1:
            raise RuntimeError(f"{name}: テンプレート文字列が 1 つではありません（{len(literals)} 個）")
        prompts[stage] = literals[0]
    return prompts


def git_commit(path: Path) -> str:
    try:
        return subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip()
    except Exception:
        return "unknown"


def layout(index: int, cluster_nums: list[int]) -> dict:
    """index 番目の意見の座標とクラスタを決める（入れ子になる・密度が同点にならない規則）。"""
    top_n, deep_n = cluster_nums
    deep = index % deep_n
    top = deep * top_n // deep_n
    k = index // deep_n
    center_x = 10.0 * (deep % 3)
    center_y = 10.0 * (deep // 3)
    spread = 0.3 + 0.2 * deep + 0.05 * k
    angle = k * 1.3 + deep
    return {
        "x": round(center_x + spread * math.cos(angle), 6),
        "y": round(center_y + spread * math.sin(angle), 6),
        # 本家 hierarchical_clustering と同じ書式。上位は scipy fcluster（1 始まり）、最下層は KMeans（0 始まり）
        "cluster_ids": [f"1_{top + 1}", f"2_{deep}"],
    }


def run_case(case: dict, prompts: dict[str, str], analysis_core) -> dict:
    import polars as pl

    steps = analysis_core["steps"]
    requests: list[dict] = []

    def fake_request_to_chat_ai(messages, *args, **kwargs):
        system = messages[0]["content"]
        user = messages[-1]["content"]
        stage = fake_llm.stage_of(system, prompts)
        requests.append({"stage": stage, "user": fake_llm.canonicalize(stage, user)})
        return fake_llm.respond(stage, user), 0, 0, 0

    for module in steps.values():
        if hasattr(module, "request_to_chat_ai"):
            module.request_to_chat_ai = fake_request_to_chat_ai

    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        input_dir = base / "inputs"
        output_root = base / "outputs"
        output_dir = output_root / "case"
        input_dir.mkdir()
        output_dir.mkdir(parents=True)

        # 管理画面から作った時と同じく、属性列は attribute_ を付けて analysis-core に渡す（report_launcher.save_input_file）
        user_df = pl.read_csv(io.StringIO(case["csv"]), infer_schema_length=0)
        rename = {col: f"attribute_{col}" for col in case["attribute_columns"]}
        input_df = user_df.rename(rename).with_columns(
            pl.lit(None, dtype=pl.Utf8).alias("source"), pl.lit(None, dtype=pl.Utf8).alias("url")
        )
        input_df.write_csv(input_dir / "case.csv")

        # 管理画面からの実行と同じ形の config（report_launcher._build_config）を normalize_config で補う
        api_config = {
            "name": "case",
            "input": "case",
            "question": case["question"],
            "intro": case["intro"],
            "model": case["model"],
            "provider": "openai",
            "analysis_mode": "hierarchical",
            "is_pubcom": False,
            "is_embedded_at_local": False,
            "extraction": {"prompt": prompts["extraction"], "workers": 1, "limit": len(user_df)},
            "hierarchical_overview": {"prompt": prompts["overview"]},
            "hierarchical_aggregation": {"sampling_num": 1},
            "enable_source_link": False,
            "enable_original_comments": case["enable_original_comments"],
            "hierarchical_clustering": {"cluster_nums": case["cluster_nums"], "save_umap_model": False},
            "hierarchical_initial_labelling": {
                "prompt": prompts["initial_labelling"],
                "sampling_num": case["sampling_num"],
                "workers": 1,
            },
            "hierarchical_merge_labelling": {
                "prompt": prompts["merge_labelling"],
                "sampling_num": case["sampling_num"],
                "workers": 1,
            },
        }
        config = analysis_core["normalize_config"](api_config, include_source_code=False)
        config.update(
            {"output_dir": "case", "_input_base_dir": str(input_dir), "_output_base_dir": str(output_root)}
        )

        quiet = contextlib.redirect_stdout(io.StringIO())
        with quiet:
            steps["extraction"].extraction(config)
        args_df = pl.read_csv(output_dir / "args.csv", infer_schema_length=0)
        relations_df = pl.read_csv(output_dir / "relations.csv", infer_schema_length=0)
        extraction = {
            "args": [{"arg_id": r["arg-id"], "argument": r["argument"]} for r in args_df.iter_rows(named=True)],
            "relations": [
                {"arg_id": r["arg-id"], "comment_id": r["comment-id"]} for r in relations_df.iter_rows(named=True)
            ],
        }
        result = {"extraction": extraction}

        if case["downstream"]:
            placements = [layout(i, case["cluster_nums"]) for i in range(len(args_df))]
            clusters_df = pl.DataFrame(
                {
                    "arg-id": args_df["arg-id"].to_list(),
                    "argument": args_df["argument"].to_list(),
                    "x": [p["x"] for p in placements],
                    "y": [p["y"] for p in placements],
                    "cluster-level-1-id": [p["cluster_ids"][0] for p in placements],
                    "cluster-level-2-id": [p["cluster_ids"][1] for p in placements],
                }
            )
            clusters_df.write_csv(output_dir / "hierarchical_clusters.csv")
            with quiet:
                steps["hierarchical_initial_labelling"].hierarchical_initial_labelling(config)
                steps["hierarchical_merge_labelling"].hierarchical_merge_labelling(config)
                steps["hierarchical_overview"].hierarchical_overview(config)
                steps["hierarchical_aggregation"].hierarchical_aggregation(config)
            hierarchical = json.loads((output_dir / "hierarchical_result.json").read_text(encoding="utf-8"))
            public = json.loads((output_dir / "public_result.json").read_text(encoding="utf-8"))
            result["clustering"] = [
                {"arg_id": arg_id, **placement}
                for arg_id, placement in zip(args_df["arg-id"].to_list(), placements, strict=True)
            ]
            # 本家の clusters の並び順は polars の unique に依存して実行ごとに変わるので、(level, id) で固定する
            for data in (hierarchical, public):
                data["clusters"].sort(key=lambda cluster: (cluster["level"], cluster["id"]))
            config_out = hierarchical.pop("config")
            result["hierarchical_result"] = {**hierarchical, "config": {"intro": config_out["intro"]}}
            public.pop("config", None)
            result["public_result"] = public

    by_stage: dict[str, list[str]] = {}
    for request in requests:
        by_stage.setdefault(request["stage"], []).append(request["user"])
    # extraction は回答の順に送るので順番も比べる。ラベル付け・概要は並列で順不同なので並べ替える
    result["llm_requests"] = {
        stage: users if stage == "extraction" else sorted(users) for stage, users in by_stage.items()
    }
    return result


def unit_cases(analysis_core) -> dict:
    import numpy as np

    clustering = analysis_core["clustering"]
    recommended = {n: clustering.calculate_recommended_cluster_nums(n) for n in [2, 3, 7, 8, 26, 27, 64, 125, 999, 1000, 1331, 5000, 100000]}
    normalize = []
    for requested, count in [([3, 9], 100), ([9, 3, 3], 100), ([5, 50], 20), ([1, 4], 10), ([30], 12)]:
        normalize.append({"requested": requested, "count": count, "expected": clustering.normalize_cluster_nums(requested, count)})

    rng = np.random.default_rng(20261124)
    ward = []
    for n_centroids, cuts in [(4, [2, 3]), (9, [3, 5]), (16, [4, 8]), (25, [5])]:
        centroids = rng.normal(size=(n_centroids, 2)).round(6)
        kmeans_labels = np.arange(n_centroids)
        for cut in cuts:
            labels = clustering.merge_clusters_with_hierarchy(centroids, kmeans_labels, centroids, cut)
            ward.append({"centroids": centroids.tolist(), "cut": cut, "labels": [int(v) for v in labels]})

    # はっきり分かれた塊なら、KMeans の実装や乱数が違っても同じ分け方になるはず
    from sklearn.cluster import KMeans

    centers = [(0, 0), (0, 12), (12, 0), (12, 12), (30, 30), (30, 42)]
    blob_rng = np.random.default_rng(7)
    points = np.concatenate([blob_rng.normal(loc=c, scale=0.5, size=(15, 2)) for c in centers]).round(6)
    blob_results = clustering.hierarchical_clustering_embeddings(points, [2, 6], kmeans_class=lambda n_clusters: KMeans(n_clusters=n_clusters, random_state=0, n_init=10))
    blobs = {
        "points": points.tolist(),
        "cluster_nums": [2, 6],
        "labels": [[int(v) for v in labels] for labels in blob_results.values()],
    }

    labelling = analysis_core["labelling"]
    overview = analysis_core["steps"]["hierarchical_overview"]
    parse = analysis_core["parse"]

    def outcome(fn, value):
        try:
            return {"ok": fn(value)}
        except Exception as error:  # noqa: BLE001 — 例外の種類は問わず「失敗した」ことだけを比べる
            return {"error": type(error).__name__}

    extraction_inputs = [
        '{"extractedOpinionList": ["意見A", "意見B"]}',
        '{"extractedOpinionList": []}',
        '{"extractedOpinionList": ["  前後に空白  ", ""]}',
        '```json\n{"extractedOpinionList": ["意見A"]}\n```',
        '["意見A", "意見B"]',
        '{"opinions": ["意見A"]}',
        "申し訳ありませんが、お手伝いできません。",
        '{"extractedOpinionList": ["意見A",]}',
    ]
    label_inputs = [
        '{"label": "ラベル", "description": "説明"}',
        '{"label": "ラベル", "description": ""}',
        '{"label": "", "description": "説明"}',
        '{"label": "ラベル"}',
        '<think>考え中</think>{"label": "ラベル", "description": "説明"}',
        "ラベルを付けられませんでした",
    ]
    overview_inputs = [
        '{"summary": "全体の要約"}',
        '<think>考え中</think>{"summary": "全体の要約"}',
        "JSON ではない要約文",
        '{"summary": ""}',
        '{"other": "x"}',
        '{"summary": "途中で切れ',
        "",
    ]

    def extraction_parse(value):
        return [item for item in parse.parse_extraction_response(value) if item]

    return {
        "recommended_cluster_nums": [{"count": n, "expected": v} for n, v in recommended.items()],
        "normalize_cluster_nums": normalize,
        "ward_merge": ward,
        "separated_blobs": blobs,
        "parse": {
            "extraction": [{"input": v, **outcome(extraction_parse, v)} for v in extraction_inputs],
            "label": [{"input": v, **outcome(labelling.parse_label, v)} for v in label_inputs],
            "overview": [{"input": v, **outcome(overview._extract_summary, v)} for v in overview_inputs],
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--kouchou-ai", type=Path, required=True, help="kouchou-ai リポジトリの場所")
    parser.add_argument("--out", type=Path, default=HERE / "expected")
    options = parser.parse_args()

    kouchou_ai = options.kouchou_ai.resolve()
    sys.path.insert(0, str(kouchou_ai / "packages/analysis-core/src"))
    import importlib

    from analysis_core.compat.config_converter import normalize_config

    step_names = [
        "extraction",
        "hierarchical_initial_labelling",
        "hierarchical_merge_labelling",
        "hierarchical_overview",
        "hierarchical_aggregation",
    ]
    analysis_core = {
        "normalize_config": normalize_config,
        "steps": {name: importlib.import_module(f"analysis_core.steps.{name}") for name in step_names},
        "clustering": importlib.import_module("analysis_core.steps.hierarchical_clustering"),
        "labelling": importlib.import_module("analysis_core.steps._labelling"),
        "parse": importlib.import_module("analysis_core.services.parse_json_list"),
    }

    prompts = read_admin_prompts(kouchou_ai)
    options.out.mkdir(parents=True, exist_ok=True)
    meta = {"kouchou_ai_commit": git_commit(kouchou_ai), "generator": "conformance/generate_expected.py"}

    def write(name: str, data: dict) -> None:
        path = options.out / name
        path.write_text(json.dumps({**meta, **data}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {path}")

    write("prompts.json", {"prompts": prompts})
    write("units.json", unit_cases(analysis_core))
    for case_path in sorted((HERE / "cases").glob("*.json")):
        case = json.loads(case_path.read_text(encoding="utf-8"))
        write(f"case-{case['id']}.json", {"case": case["id"], **run_case(case, prompts, analysis_core)})


if __name__ == "__main__":
    main()
