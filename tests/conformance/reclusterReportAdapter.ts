import { readFileSync } from "node:fs";
import { parseResultJson } from "../../src/lib/export";
import { clusterXY } from "../../src/lib/pipeline/clusteringCore";
import { buildClusterTable, uniqueClusterIds } from "../../src/lib/pipeline/clusterTable";
import { aggregation } from "../../src/lib/pipeline/steps/aggregation";
import { buildPublicResult } from "../../src/lib/publicResult";
import { projectFromResult } from "../../src/lib/reportProject";
import { DEFAULT_SETTINGS } from "../../src/types/settings";

const sourceReport = parseResultJson(readFileSync(0, "utf8"));
const { project, extraction, clustering } = projectFromResult(sourceReport, {
  id: "imported-project",
  reportId: "imported-report",
  title: "公開レポートの再クラスタリング",
  settings: DEFAULT_SETTINGS,
});

// 対話画面と同じく、インポートした座標から切り直す。ラベルと概要は固定し、外部APIを呼ばない。
const points = Array.from(clustering.x, (x, i) => [x, clustering.y[i]]);
const newClustering = clusterXY(points, [2], "public-report-contract");
const table = buildClusterTable(extraction.args, { ...clustering, ...newClustering });
const labels = uniqueClusterIds(table, 1).map((clusterId) => ({
  clusterId,
  label: "再分類したグループ",
  description: "再分類後の説明",
}));
const result = aggregation({
  project,
  comments: project.comments,
  extractionResult: extraction,
  table,
  labels: { byLevel: { 1: labels } },
  overviewText: "再分類後の概要",
  chatModel: "test-labeller",
  embeddingModel: "test-embedding",
  workers: 1,
  sourceReport,
});

process.stdout.write(JSON.stringify(buildPublicResult(result)));
