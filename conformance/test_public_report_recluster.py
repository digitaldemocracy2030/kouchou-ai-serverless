"""Recluster the Python producer's public JSON in the browser implementation."""

import json
import subprocess
from collections import Counter
from pathlib import Path
from tempfile import TemporaryFile

import pytest
from analysis_core.public_result import build_public_result
from python_report import make_report

ROOT = Path(__file__).resolve().parents[1]
COMMENTS = [
    ("001", "最初の回答", "01", [("歩道を広げる", 0.8), ("夜のバスを増やす", -0.5)]),
    ("9007199254740992", "別の回答", "北", [("歩道を広げる", 0)]),
    ("9007199254740993", "さらに別の回答", "南", [("信号を増やす", 0.3)]),
    ("4", "抽出される意見がない回答", "西", []),
    ("5", "もう一つの意見がない回答", "東", []),
]
EXPECTED_ATTRIBUTES = {
    (comment_id, opinion): {"region": region, "stance_score": score}
    for comment_id, _, region, opinions in COMMENTS
    for opinion, score in opinions
}


def public_report(publish_comments, with_property_map):
    report = make_report(
        {
            "depth": 1,
            "publishComments": publish_comments,
            "comments": [
                {
                    "id": comment_id,
                    "body": body,
                    "region": region,
                    "opinions": [opinion for opinion, _ in opinions],
                    "paths": [[0] for _ in opinions],
                }
                for comment_id, body, region, opinions in COMMENTS
            ],
        }
    )["report"]
    # Optional analysis can assign different numeric scores to opinions from the same input row.
    for arg in report["arguments"]:
        attributes = EXPECTED_ATTRIBUTES[arg["comment_id"], arg["argument"]]
        arg["attributes"]["stance_score"] = attributes["stance_score"]
        arg["url"] = f"https://example.invalid/responses/{arg['comment_id']}"
    report["config"]["enable_source_link"] = True
    if with_property_map:
        arg = report["arguments"][0]
        report["propertyMap"] = {"region": {arg["arg_id"]: arg["attributes"]["region"]}}
    else:
        report["propertyMap"] = {}
    return build_public_result(report)


def recluster_in_typescript(source):
    # A file on stdin avoids nonblocking pipe reads in the Node adapter.
    with TemporaryFile(mode="w+", encoding="utf-8") as stdin:
        json.dump(source, stdin, ensure_ascii=False)
        stdin.seek(0)
        process = subprocess.run(
            [
                "node",
                "node_modules/vite-node/dist/cli.mjs",
                "tests/conformance/reclusterReportAdapter.ts",
            ],
            cwd=ROOT,
            stdin=stdin,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
    assert process.returncode == 0, process.stderr + process.stdout
    return json.loads(process.stdout)


@pytest.mark.parametrize("publish_comments", [False, True], ids=["private", "public"])
@pytest.mark.parametrize(
    "with_property_map", [False, True], ids=["empty-map", "sparse-map"]
)
def test_python_public_report_survives_browser_reclustering(
    publish_comments, with_property_map
):
    source = public_report(publish_comments, with_property_map)
    assert bool(source["propertyMap"]) is with_property_map
    reclustered = recluster_in_typescript(source)

    expected_comments = (
        {
            comment_id: {"comment": body}
            for comment_id, body, _, opinions in COMMENTS
            if opinions
        }
        if publish_comments
        else {}
    )
    for report in (source, reclustered):
        assert report["comments"] == expected_comments
        assert report["config"]["enable_original_comments"] is publish_comments
        assert report["config"]["enable_source_link"] is True
        assert type(report["comment_num"]) is int and report["comment_num"] == len(
            COMMENTS
        )
        assert len(report["arguments"]) == len(EXPECTED_ATTRIBUTES)
        assert {
            (arg["comment_id"], arg["argument"]): arg.get("attributes")
            for arg in report["arguments"]
        } == EXPECTED_ATTRIBUTES
        for arg in report["arguments"]:
            assert (
                arg["url"] == f"https://example.invalid/responses/{arg['comment_id']}"
            )
            attributes = EXPECTED_ATTRIBUTES[arg["comment_id"], arg["argument"]]
            for name, value in attributes.items():
                assert type(arg["attributes"][name]) is type(value), (
                    f"{name} changed JSON type"
                )

    assert {
        arg["arg_id"]: (arg["comment_id"], arg["argument"])
        for arg in reclustered["arguments"]
    } == {
        arg["arg_id"]: (arg["comment_id"], arg["argument"])
        for arg in source["arguments"]
    }
    assert reclustered["propertyMap"] == source["propertyMap"]

    # Start with one leaf and require two after clustering, with counts derived from membership.
    assert sum(cluster["level"] == 1 for cluster in source["clusters"]) == 1
    assert sum(cluster["level"] == 1 for cluster in reclustered["clusters"]) == 2
    assert reclustered["config"]["hierarchical_clustering"]["cluster_nums"] == [2]
    memberships = Counter(
        cluster_id
        for arg in reclustered["arguments"]
        for cluster_id in arg["cluster_ids"]
    )
    assert {
        cluster["id"]: cluster["value"] for cluster in reclustered["clusters"]
    } == memberships
