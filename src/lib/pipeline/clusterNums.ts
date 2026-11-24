// 本家 hierarchical_clustering.py calculate_recommended_cluster_nums の移植。
// cube-root ルール: lv1 = clamp(round(N^(1/3)), 2, 10), lv2 = clamp(lv1^2, 2, min(1000, N))

export function calculateRecommendedClusterNums(argumentCount: number): number[] {
  if (argumentCount < 2) {
    throw new Error("argument_count must be at least 2");
  }
  const lv1 = Math.max(2, Math.min(10, Math.round(argumentCount ** (1 / 3))));
  const lv2 = Math.max(2, Math.min(1000, argumentCount, lv1 * lv1));
  return [...new Set([lv1, lv2])].sort((a, b) => a - b);
}

/** 空欄は自動、未対応の指定を含む場合は入力エラー。 */
export function parseRequestedClusterNums(text: string): number[] | null {
  if (!text.trim()) return [];
  const numbers = text
    .split(/[,、\s]+/)
    .filter(Boolean)
    .map(Number);
  if (!numbers.length || numbers.some((number) => !Number.isSafeInteger(number) || number < 2)) return null;
  return [...new Set(numbers)].sort((a, b) => a - b);
}
