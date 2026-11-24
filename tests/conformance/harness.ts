import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";

// 適合性テストの共通部品。
// 期待値は conformance/generate_expected.py が本家（analysis-core）を実際に動かして作る。

const ROOT = join(import.meta.dirname, "..", "..", "conformance");

export function readExpected<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(join(ROOT, "expected", name), "utf8")) as T;
}

export function readCase<T = Record<string, unknown>>(id: string): T {
  return JSON.parse(readFileSync(join(ROOT, "cases", `${id}.json`), "utf8")) as T;
}

export function caseIds(): string[] {
  return readdirSync(join(ROOT, "cases"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/, ""))
    .sort();
}

type Divergence = { reason: string };
const KNOWN: Record<string, Divergence> = JSON.parse(
  readFileSync(join(ROOT, "known-divergences.json"), "utf8"),
).divergences;
const used = new Set<string>();

/**
 * 本家との一致を確かめる it。
 * id が conformance/known-divergences.json に載っていれば「今は一致しない」ことを確かめる（it.fails）。
 * 直して一致するようになると、このテストが落ちるので一覧から外す（差が黙って増減しない）。
 */
export function conform(id: string, title: string, fn: () => void | Promise<void>): void {
  const known = KNOWN[id];
  if (known) {
    used.add(id);
    it.fails(`[${id}] ${title}（既知の差: ${known.reason}）`, fn);
  } else {
    it(`[${id}] ${title}`, fn);
  }
}

/** 一覧にあるのに、どのテストにも使われていない id（typo や消し忘れ） */
export function unusedKnownDivergenceIds(): string[] {
  return Object.keys(KNOWN).filter((id) => !used.has(id));
}

/** Python の sorted() と同じ並べ方 */
export function sortByCodePoint(values: string[]): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** ラベルの付け方（番号）を無視して、同じ分け方かどうかを比べられる形にする */
export function partition(labels: ArrayLike<number | string>): number[][] {
  const groups = new Map<string, number[]>();
  for (let i = 0; i < labels.length; i++) {
    const key = String(labels[i]);
    const group = groups.get(key) ?? [];
    group.push(i);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a[0] - b[0]);
}
