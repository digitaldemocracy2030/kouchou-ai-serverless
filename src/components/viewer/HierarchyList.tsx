import { useMemo } from "react";
import { readCommentIds } from "../../lib/opinionSources";
import type { Argument, Cluster, Comments } from "../../types/result";

// 本家 HierarchyListChart 相当: クラスタ階層を入れ子リストで表示する。

type Props = {
  clusterList: Cluster[];
  argumentList: Argument[];
  filteredArgumentIds?: Set<string>;
  textSearch: string;
  comments?: Comments;
};

function OriginalResponses({ argument, comments }: { argument: Argument; comments: Comments }) {
  let ids: string[];
  try {
    ids = readCommentIds(argument);
  } catch {
    // 旧形式の保存データに不正な出典IDがあっても、その意見は引き続き表示する。
    return null;
  }
  const responses = ids.flatMap((id) => {
    const body = Object.hasOwn(comments, id) ? comments[id]?.comment : undefined;
    return typeof body === "string" && body.trim() ? [{ id, body }] : [];
  });
  if (responses.length === 0) return null;

  return (
    <details className="original-responses">
      <summary>元の回答を見る{responses.length > 1 && `（${responses.length}件）`}</summary>
      {responses.map(({ id, body }) => (
        <p key={id}>{body}</p>
      ))}
    </details>
  );
}

export function HierarchyList({ clusterList, argumentList, filteredArgumentIds, textSearch, comments }: Props) {
  const childrenByParent = useMemo(() => {
    const map = new Map<string, Cluster[]>();
    for (const cluster of clusterList) {
      if (cluster.level === 0) continue;
      const list = map.get(cluster.parent) ?? [];
      list.push(cluster);
      map.set(cluster.parent, list);
    }
    return map;
  }, [clusterList]);

  const argsByCluster = useMemo(() => {
    const map = new Map<string, Argument[]>();
    for (const arg of argumentList) {
      if (filteredArgumentIds && !filteredArgumentIds.has(arg.arg_id)) continue;
      const deepest = arg.cluster_ids[arg.cluster_ids.length - 1];
      const list = map.get(deepest) ?? [];
      list.push(arg);
      map.set(deepest, list);
    }
    return map;
  }, [argumentList, filteredArgumentIds]);

  // フィルタ適用後のクラスタ別件数(未フィルタ時は cluster.value と一致する)
  const countByCluster = useMemo(() => {
    if (!filteredArgumentIds) return null;
    const counts = new Map<string, number>();
    for (const arg of argumentList) {
      if (!filteredArgumentIds.has(arg.arg_id)) continue;
      for (const id of arg.cluster_ids) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return counts;
  }, [argumentList, filteredArgumentIds]);

  const renderCluster = (cluster: Cluster): React.ReactNode => {
    const count = countByCluster ? (countByCluster.get(cluster.id) ?? 0) : cluster.value;
    // フィルタで空になった枝は表示しない
    if (countByCluster && count === 0) return null;
    const children = childrenByParent.get(cluster.id) ?? [];
    const args = children.length === 0 ? (argsByCluster.get(cluster.id) ?? []) : [];
    return (
      <details key={cluster.id} className="hierarchy-node" open={cluster.level <= 1 || Boolean(textSearch)}>
        <summary>
          <b>{cluster.label}</b>{" "}
          <span className="note">
            ({count.toLocaleString()}
            {countByCluster ? ` / ${cluster.value.toLocaleString()}` : ""} 件)
          </span>
        </summary>
        {cluster.takeaway && <p className="note hierarchy-takeaway">{cluster.takeaway}</p>}
        <div className="hierarchy-children">
          {children.map(renderCluster)}
          {args.length > 0 && (
            <ul className="argument-list">
              {args.map((arg) => (
                <li key={arg.arg_id}>
                  {arg.argument}
                  {comments && <OriginalResponses argument={arg} comments={comments} />}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    );
  };

  const roots = childrenByParent.get("0") ?? [];
  return (
    <div className="hierarchy-list" key={textSearch}>
      {roots.map(renderCluster)}
    </div>
  );
}
