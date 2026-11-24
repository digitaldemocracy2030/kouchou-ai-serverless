"""One generated input and one contract, exercised by both report producers."""

import json
import math
import os
import subprocess
from collections import Counter, defaultdict
from pathlib import Path

import pytest
from hypothesis import given, settings, strategies as st
from python_report import cluster_points, make_report

ROOT = Path(__file__).resolve().parents[1]
TS_ADAPTER = [
    "node",
    "node_modules/vite-node/dist/cli.mjs",
    "tests/conformance/reportAdapter.ts",
]
COMMENT_IDS = ["001", "1", "9007199254740992", "9007199254740993", "回答-A", "a_1"]
OPINIONS = [
    "歩道を広げる",
    "バスを増やす",
    "公園の「入口」, 看板を見直す",
    '案内に "英語" と \\ を含める',
]


@st.composite
def report_cases(draw):
    depth = draw(st.integers(1, 4))
    ids = draw(
        st.lists(
            st.sampled_from(COMMENT_IDS),
            min_size=2,
            max_size=len(COMMENT_IDS),
            unique=True,
        )
    )
    # Each comment has its own LLM response. Repeated opinions within a comment
    # should collapse; the same opinion from two different comments should survive.
    lists = [
        draw(st.lists(st.sampled_from(OPINIONS), min_size=int(i == 0), max_size=5))
        for i in range(len(ids))
    ]
    prefixes = [{} for _ in range(depth)]
    comments = []
    for index, (comment_id, opinions) in enumerate(zip(ids, lists, strict=True)):
        paths_by_text = {}
        for opinion in dict.fromkeys(opinions):
            branches = draw(st.lists(st.integers(0, 2), min_size=depth, max_size=depth))
            path = []
            for level, numbering in enumerate(prefixes):
                prefix = tuple(branches[: level + 1])
                path.append(numbering.setdefault(prefix, len(numbering)))
            paths_by_text[opinion] = path
        comments.append(
            {
                "id": comment_id,
                "body": f'原文 "{index}", {draw(st.sampled_from(["あ", "🙂", "改行\nあり"]))}',
                "region": draw(st.sampled_from(["01", "北", "南,西", '東"中央'])),
                "opinions": opinions,
                "paths": [paths_by_text[opinion] for opinion in opinions],
            }
        )
    return {
        "depth": depth,
        "comments": comments,
        "publishComments": draw(st.booleans()),
    }


def check_report(report, case):
    comments = {c["id"]: c for c in case["comments"]}
    expected = {
        (c["id"], text): path
        for c in comments.values()
        for text, path in zip(c["opinions"], c["paths"], strict=True)
    }
    assert type(report["comment_num"]) is int and report["comment_num"] == len(comments)
    assert report["config"]["enable_original_comments"] is case["publishComments"]
    expected_comments = (
        {cid: {"comment": comments[cid]["body"]} for cid, _ in expected}
        if case["publishComments"]
        else {}
    )
    assert report["comments"] == expected_comments
    assert isinstance(report["overview"], str) and report["overview"].strip()

    clusters = {c["id"]: c for c in report["clusters"]}
    assert len(clusters) == len(report["clusters"]), "duplicate cluster ID"
    roots = [c for c in clusters.values() if c["level"] == 0]
    assert len(roots) == 1 and roots[0]["parent"] == ""
    for cluster_id, cluster in clusters.items():
        level = cluster["level"]
        assert isinstance(cluster_id, str) and cluster_id
        assert type(level) is int and 0 <= level <= case["depth"]
        assert type(cluster["value"]) is int and cluster["value"] > 0
        assert isinstance(cluster["label"], str) and cluster["label"].strip()
        assert isinstance(cluster["takeaway"], str)
        if level:
            assert cluster["takeaway"].strip()
            parent = clusters.get(cluster["parent"])
            assert parent is not None and parent["level"] == level - 1, "invalid parent"

    counts = Counter()
    pairs = set()
    ids = set(clusters)
    expected_groups = [defaultdict(set) for _ in range(case["depth"])]
    observed_groups = [defaultdict(set) for _ in range(case["depth"])]
    for arg in report["arguments"]:
        arg_id = arg["arg_id"]
        assert isinstance(arg_id, str) and arg_id and arg_id not in ids, (
            "duplicate or invalid opinion ID"
        )
        ids.add(arg_id)
        pair = arg["comment_id"], arg["argument"]
        assert pair in expected and pair not in pairs, (
            "invalid opinion-to-comment relation"
        )
        pairs.add(pair)
        assert arg["attributes"]["region"] == comments[pair[0]]["region"]
        for field in ("x", "y"):
            assert type(arg[field]) in (int, float) and math.isfinite(arg[field])

        path = arg["cluster_ids"]
        assert len(path) == case["depth"] + 1 and path[0] == roots[0]["id"]
        for level, cluster_id in enumerate(path):
            assert cluster_id in clusters, "unknown cluster reference"
            cluster = clusters[cluster_id]
            assert cluster["level"] == level
            if level:
                assert cluster["parent"] == path[level - 1], "broken opinion path"
                # Compare memberships, without depending on emitted IDs or order.
                expected_groups[level - 1][expected[pair][level - 1]].add(pair)
                observed_groups[level - 1][cluster_id].add(pair)
        counts.update(path)

    assert pairs == expected.keys(), "lost opinions"
    for expected_level, observed_level in zip(
        expected_groups, observed_groups, strict=True
    ):
        assert {frozenset(g) for g in expected_level.values()} == {
            frozenset(g) for g in observed_level.values()
        }
    assert {cid: c["value"] for cid, c in clusters.items()} == dict(counts), (
        "cluster counts disagree"
    )


def check_public(report, output):
    assert output["schema_version"] == 1
    arg_ids = {argument["arg_id"] for argument in output["arguments"]}
    for property_name, values_by_arg in output["propertyMap"].items():
        unknown_ids = values_by_arg.keys() - arg_ids
        assert not unknown_ids, (
            f"propertyMap[{property_name!r}] references unknown opinion IDs: {sorted(unknown_ids)}"
        )
    for collection, identifier, fields in (
        (
            "arguments",
            "arg_id",
            ("comment_id", "argument", "cluster_ids", "attributes"),
        ),
        ("clusters", "id", ("level", "parent", "value")),
    ):
        published = {item[identifier]: item for item in output[collection]}
        assert len(published) == len(output[collection]) == len(report[collection])
        for item in report[collection]:
            for field in fields:
                assert published[item[identifier]].get(field) == item.get(field), (
                    f"publishing changed {field}"
                )
    assert output["comments"] == report["comments"]
    assert output["comment_num"] == report["comment_num"]
    assert {
        "input",
        "output_dir",
        "user_api_key",
        "_input_base_dir",
        "_output_base_dir",
    }.isdisjoint(output["config"])


def run_typescript(*args, data=None):
    process = subprocess.run(
        [*TS_ADAPTER, *args],
        cwd=ROOT,
        input=data,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
    )
    assert process.returncode == 0, process.stderr + process.stdout
    return process.stdout


def test_default_prompts():
    upstream = os.environ.get("KOUCHOU_AI_SOURCE")
    assert upstream, (
        "Set KOUCHOU_AI_SOURCE to the kouchou-ai checkout used by this suite"
    )
    run_typescript("prompts", upstream)


@settings(max_examples=40, deadline=None, print_blob=True)
@given(case=report_cases())
def test_both_producers_follow_the_report_contract(case):
    python = make_report(case)
    check_report(python["report"], case)
    check_public(python["report"], python["public"])

    ts = json.loads(
        run_typescript(
            data=json.dumps({"input": case, "pythonPublic": python["public"]})
        )
    )
    check_report(ts["report"], case)
    check_report(ts["public"], case)
    check_public(ts["report"], ts["public"])
    check_report(ts["importedPython"], case)
    check_public(python["report"], ts["importedPython"])


def check_nested_partitions(levels, points, cuts):
    assert len(levels) == len(cuts)
    for labels, cut in zip(levels, cuts, strict=True):
        assert len(labels) == len(points)
        assert all(type(label) is int for label in labels)
        # Tied merge distances can yield fewer clusters at a cut.
        assert 1 <= len(set(labels)) <= cut
    assert len(set(levels[-1])) == cuts[-1]
    for parents, children in zip(levels, levels[1:]):
        parents_by_child = defaultdict(set)
        for parent, child in zip(parents, children, strict=True):
            parents_by_child[child].add(parent)
        assert all(len(group) == 1 for group in parents_by_child.values()), (
            "non-nested clusters"
        )


@settings(max_examples=20, deadline=None, print_blob=True)
@given(
    points=st.lists(
        st.tuples(st.integers(-100, 100), st.integers(-100, 100)),
        min_size=8,
        max_size=24,
        unique=True,
    )
)
def test_both_clustering_implementations_produce_nested_partitions(points):
    cuts = [2, 3, 5]
    check_nested_partitions(cluster_points(points, cuts), points, cuts)
    ts = json.loads(
        run_typescript("clustering", data=json.dumps({"points": points, "cuts": cuts}))
    )
    check_nested_partitions(ts, points, cuts)


@pytest.mark.parametrize("damage", ["dangling", "duplicate", "count", "leak"])
def test_contract_detects_broken_reports(damage):
    case = {
        "depth": 1,
        "publishComments": False,
        "comments": [
            {
                "id": "001",
                "body": "原文",
                "region": "01",
                "opinions": ["意見"],
                "paths": [[0]],
            }
        ],
    }
    report = make_report(case)["report"]
    check_report(report, case)
    if damage == "dangling":
        report["arguments"][0]["cluster_ids"][1] = "missing"
    elif damage == "duplicate":
        report["clusters"].append(report["clusters"][1].copy())
    elif damage == "count":
        report["clusters"][0]["value"] += 1
    else:
        report["comments"]["001"] = {"comment": "原文"}
    with pytest.raises(AssertionError):
        check_report(report, case)
