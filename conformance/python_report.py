"""Adapt generated cases to analysis-core's CSV and LLM boundaries."""

import io
import json
from contextlib import redirect_stdout
from functools import partial
from importlib import import_module
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import numpy as np
import polars as pl
from analysis_core.compat.config_converter import normalize_config
from analysis_core.steps.hierarchical_aggregation import hierarchical_aggregation
from analysis_core.steps.hierarchical_clustering import (
    hierarchical_clustering_embeddings,
)
from sklearn.cluster import KMeans


def cluster_points(points, cuts):
    with redirect_stdout(io.StringIO()):
        levels = hierarchical_clustering_embeddings(
            np.array(points),
            cuts,
            kmeans_class=partial(KMeans, random_state=0, n_init=10),
        )
    return [levels[cut].tolist() for cut in cuts]


def run_llm_step(name, config, fake_chat):
    module = import_module(f"analysis_core.steps.{name}")
    with patch.object(module, "request_to_chat_ai", fake_chat):
        getattr(module, name)(config)


def make_report(case):
    comments = case["comments"]
    responses = {comment["body"]: comment["opinions"] for comment in comments}
    placements = {
        (comment["id"], text): path
        for comment in comments
        for text, path in zip(comment["opinions"], comment["paths"], strict=True)
    }

    def fake_chat(messages, *args, **kwargs):
        prompt = messages[0]["content"]
        if prompt == "extraction":
            response = {"extractedOpinionList": responses[messages[-1]["content"]]}
        elif prompt == "overview":
            response = {"summary": "調査の概要"}
        elif prompt == "labelling":
            response = {"label": "クラスタ", "description": "クラスタの説明"}
        else:
            raise AssertionError(f"unexpected prompt: {prompt}")
        return json.dumps(response, ensure_ascii=False), 0, 0, 0

    with TemporaryDirectory() as tmp, redirect_stdout(io.StringIO()):
        root = Path(tmp)
        output = root / "case"
        output.mkdir()
        pl.DataFrame(
            {
                "comment-id": [c["id"] for c in comments],
                "comment-body": [c["body"] for c in comments],
                "attribute_region": [c["region"] for c in comments],
            }
        ).write_csv(root / "case.csv")
        config = normalize_config(
            {
                "input": "case",
                "output_dir": "case",
                "question": "調査",
                "enable_original_comments": case["publishComments"],
                "_input_base_dir": tmp,
                "_output_base_dir": tmp,
                "extraction": {
                    "prompt": "extraction",
                    "workers": 1,
                    "limit": len(comments),
                },
                "hierarchical_initial_labelling": {"prompt": "labelling", "workers": 1},
                "hierarchical_merge_labelling": {"prompt": "labelling", "workers": 1},
                "hierarchical_overview": {"prompt": "overview"},
            },
            include_source_code=False,
        )

        run_llm_step("extraction", config, fake_chat)

        arguments = pl.read_csv(output / "args.csv", infer_schema_length=0)
        relations = pl.read_csv(output / "relations.csv", infer_schema_length=0)
        comment_by_arg = dict(relations.select("arg-id", "comment-id").iter_rows())
        paths = [
            placements[comment_by_arg[arg_id], text]
            for arg_id, text in arguments.iter_rows()
        ]
        n = len(paths)
        arguments.with_columns(
            pl.Series("x", [i * 0.25 for i in range(n)]),
            pl.Series("y", [i % 3 * 0.5 for i in range(n)]),
            *(
                pl.Series(
                    f"cluster-level-{level + 1}-id",
                    [f"{level + 1}_{p[level]}" for p in paths],
                )
                for level in range(case["depth"])
            ),
        ).write_csv(output / "hierarchical_clusters.csv")

        for step in (
            "hierarchical_initial_labelling",
            "hierarchical_merge_labelling",
            "hierarchical_overview",
        ):
            run_llm_step(step, config, fake_chat)
        hierarchical_aggregation(config)
        return {
            "report": json.loads(
                (output / "hierarchical_result.json").read_text(encoding="utf-8")
            ),
            "public": json.loads(
                (output / "public_result.json").read_text(encoding="utf-8")
            ),
        }
