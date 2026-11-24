"""本家と serverless の両方に同じ応答を返す、決まった振る舞いの偽 LLM。

TypeScript 側の対になる実装は tests/conformance/fakeLlm.ts。
片方を変えたら必ずもう片方も同じように変えること（期待値の再生成も必要）。

応答は「どの段の依頼か」と「依頼文を正規化したもの」だけから決まる。
本家は意見の並び順・子クラスタの並び順が実行ごとに変わりうる（polars の unique / sample）ので、
並び順だけが違う依頼は同じ依頼として扱い、同じ応答を返す。
"""

from __future__ import annotations

import hashlib
import json
import re

EMPTY_MARKER = "特になし"
MERGE_SEPARATOR = "\nクラスタの意見\n"
MERGE_HEAD = "クラスタラベル\n"
OVERVIEW_BLOCK = re.compile(r"# Cluster \d+/(\d+): ")


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonicalize(stage: str, user: str) -> str:
    """並び順に意味のない部分を並べ替えた依頼文を返す。"""
    if stage == "extraction":
        return user
    if stage == "initial_labelling":
        return "\n".join(sorted(user.split("\n")))
    if stage == "merge_labelling":
        if not user.startswith(MERGE_HEAD) or MERGE_SEPARATOR not in user:
            return user
        labels, opinions = user[len(MERGE_HEAD) :].split(MERGE_SEPARATOR, 1)
        return (
            MERGE_HEAD
            + "\n".join(sorted(labels.split("\n")))
            + MERGE_SEPARATOR
            + "\n".join(sorted(opinions.split("\n")))
        )
    if stage == "overview":
        matches = list(OVERVIEW_BLOCK.finditer(user))
        if not matches:
            return user
        blocks = []
        for index, match in enumerate(matches):
            end = matches[index + 1].start() if index + 1 < len(matches) else len(user)
            blocks.append(f"# Cluster ?/{match.group(1)}: " + user[match.end() : end])
        return user[: matches[0].start()] + "".join(sorted(blocks))
    raise ValueError(f"unknown stage: {stage}")


def respond(stage: str, user: str) -> str:
    """LLM の応答本文（JSON 文字列）を返す。"""
    if stage == "extraction":
        if EMPTY_MARKER in user:
            return json.dumps({"extractedOpinionList": []}, ensure_ascii=False)
        opinions = [part.strip() + "。" for part in user.split("。") if part.strip()]
        return json.dumps({"extractedOpinionList": opinions}, ensure_ascii=False)
    digest = _sha(f"{stage}\n{canonicalize(stage, user)}")
    if stage in ("initial_labelling", "merge_labelling"):
        prefix = "初期" if stage == "initial_labelling" else "統合"
        return json.dumps(
            {"label": f"{prefix}ラベル{digest[:6]}", "description": f"{prefix}説明{digest[6:18]}"},
            ensure_ascii=False,
        )
    if stage == "overview":
        return json.dumps({"summary": f"概要{digest[:12]}"}, ensure_ascii=False)
    raise ValueError(f"unknown stage: {stage}")


def stage_of(system_prompt: str, prompts: dict[str, str]) -> str:
    """system prompt から段を判定する（prompts は {段: プロンプト}）。"""
    for stage, prompt in prompts.items():
        if system_prompt == prompt:
            return stage
    raise ValueError("system prompt がどの段のプロンプトとも一致しません")
