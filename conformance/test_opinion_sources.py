"""Compare the Python and TypeScript report paths to the same Lean model."""

import json
import os
import runpy
import subprocess
from functools import cache
from pathlib import Path

import pytest
from hypothesis import given, settings, strategies as st

from test_report_contract import run_typescript

SOURCE_IDS = ["001", "1", "9007199254740992", "9007199254740993", "__proto__", "出典"]


@cache
def spec_dir():
    return (
        Path(os.environ["KOUCHOU_AI_SOURCE"])
        / "packages/analysis-core/verification/opinion-sources"
    )


@cache
def python_producer():
    return runpy.run_path(str(spec_dir() / "python_adapter.py"))["write_public"]


def project_report(report):
    arguments = sorted(
        [
            {
                key: argument[key]
                for key in ("arg_id", "comment_id", "comment_ids")
                if key in argument
            }
            for argument in report["arguments"]
        ],
        key=lambda argument: argument["arg_id"],
    )
    edges = set()
    relation_count = 0
    for argument in arguments:
        primary = argument["comment_id"]
        assert isinstance(primary, str)
        ids = argument.get("comment_ids", [primary] if primary else [])
        if "comment_ids" in argument:
            assert isinstance(ids, list) and len(ids) > 1
            assert all(isinstance(source, str) and source for source in ids)
            assert primary == ids[0]
            assert len(set(ids)) == len(ids)
            # Compare membership and the representative. Other sources have no display order.
            argument["comment_ids"] = sorted(ids)
        edges.update((argument["arg_id"], source) for source in ids)
        relation_count += len(ids)
    return {
        "arguments": arguments,
        "comments": report["comments"],
        "inputCount": report.get("comment_num"),
        "opinionCount": len(arguments),
        "relationCount": relation_count,
        "linkedCommentCount": len({source for _, source in edges}),
    }, edges


def check_case(case):
    model = subprocess.run(
        ["lean", "--run", "Contract.lean"],
        cwd=spec_dir(),
        input=json.dumps(case),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
    )
    assert model.returncode == 0, model.stderr + model.stdout
    expected = json.loads(model.stdout)
    python_report = python_producer()(case)
    if case["relations"] is None:
        # Pass the original JSON text to exercise precision before JavaScript parses it.
        case = {
            **case,
            "legacyReport": json.dumps(
                {
                    "arguments": [
                        {
                            "argument": arg["arg_id"],
                            "cluster_ids": [],
                            "x": 0,
                            "y": 0,
                            "p": 0,
                            **arg,
                        }
                        for arg in case["arguments"]
                    ],
                    "comments": {
                        row["id"]: {"comment": row["body"]} for row in case["comments"]
                    },
                    "clusters": [],
                    "config": {"enable_original_comments": case["publish"]},
                    "comment_num": case["inputCount"],
                }
            ),
        }
    typescript = json.loads(run_typescript("opinion-sources", data=json.dumps(case)))
    if expected.get("error"):
        assert python_report == expected
        assert typescript == expected
        return
    for argument in expected["arguments"]:
        if "comment_ids" in argument:
            argument["comment_ids"].sort()
    python_projection, edges = project_report(python_report)
    typescript_projection, _ = project_report(typescript["published"])
    assert python_projection == expected
    assert typescript_projection == expected
    restored = [(edge["argId"], edge["commentId"]) for edge in typescript["restored"]]
    assert len(restored) == len(edges)
    assert set(restored) == edges


def relation(opinion, source):
    return {"opinion": opinion, "source": source}


@pytest.mark.parametrize("publish", [False, True])
def test_many_to_many_sources_survive_publication(publish):
    check_case(
        {
            "arguments": [{"arg_id": "X"}, {"arg_id": "Y"}, {"arg_id": "Z"}],
            "relations": [
                relation("X", "001"),
                relation("Y", "001"),
                relation("X", "9007199254740992"),
                relation("X", "9007199254740993"),
                relation("X", "001"),
                relation("Y", "1"),
                relation("Y", "__proto__"),
                relation("filtered", "unused"),
            ],
            "comments": [
                {"id": "001", "body": "同文"},
                {"id": "1", "body": "同文"},
                {"id": "9007199254740992", "body": "別の回答"},
                {"id": "__proto__", "body": "回答"},
                {"id": "unused", "body": "紐づいていない原文"},
            ],
            "publish": publish,
            "inputCount": 16,
        },
    )


@st.composite
def relation_cases(draw):
    opinions = [f"A{i}" for i in range(draw(st.integers(1, 5)))]
    ids_with_bodies = draw(st.lists(st.sampled_from(SOURCE_IDS), unique=True))
    return {
        "arguments": [{"arg_id": opinion} for opinion in opinions],
        "relations": [
            relation(opinion, source)
            for opinion, source in draw(
                st.lists(
                    st.tuples(
                        st.sampled_from([*opinions, "filtered"]),
                        st.sampled_from([*SOURCE_IDS, ""]),
                    ),
                    max_size=20,
                )
            )
        ],
        "comments": [
            {"id": id_, "body": f"本文 {i}"} for i, id_ in enumerate(ids_with_bodies)
        ],
        "publish": draw(st.booleans()),
        "inputCount": draw(st.integers(len(ids_with_bodies), 100)),
    }


@settings(max_examples=20, deadline=None, print_blob=True)
@given(case=relation_cases())
def test_generated_relations_match_lean(case):
    check_case(case)


def test_legacy_single_id_and_plural_precedence():
    check_case(
        {
            "arguments": [
                {"arg_id": "A", "comment_id": 185001345000000001},
                {"arg_id": "B", "comment_id": 185001345000000002},
                {"arg_id": "C", "comment_id": 1},
                {"arg_id": "D", "comment_id": "001"},
                {
                    "arg_id": "E",
                    "comment_id": "unused",
                    "comment_ids": ["001", "1", "001"],
                },
                {"arg_id": "F", "comment_id": "unused", "comment_ids": []},
                {"arg_id": "G", "comment_id": None},
                {"arg_id": "H"},
            ],
            "relations": None,
            "comments": [{"id": "185001345000000001", "body": "旧レポートの原文"}],
            "publish": True,
            "inputCount": None,
        },
    )


@pytest.mark.parametrize(
    "reference",
    [
        {"comment_id": True},
        {"comment_id": 7.5},
        {"comment_ids": ["001", ""]},
        {"comment_ids": [1]},
    ],
)
def test_invalid_references_match_lean(reference):
    check_case(
        {
            "arguments": [{"arg_id": "A", **reference}],
            "relations": None,
            "comments": [],
            "publish": False,
            "inputCount": None,
        },
    )
