"use client";

import { Pagination, type TableProps } from "antd";
import { LuTriangleAlert } from "react-icons/lu";
import { pageSizes } from "@/lib/contracts";
import { pageChange, sortChange, type SortDir } from "@/lib/list-query";
import { updateSearch } from "@/lib/url-search";

// The Carriers and Demand tables share their row actions, sorting, error banner and pager.

export const iconButton =
  "grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted outline-none transition-colors hover:bg-panel-raised hover:text-fg focus-visible:ring-2 focus-visible:ring-accent/40";

export type AntdOrder = "ascend" | "descend";

// Text sorts A to Z first, numbers and dates most first. Neither direction clears the sort, so a
// header click always shows a sorted list.
export const textDirections: AntdOrder[] = ["ascend", "descend", "ascend"];
export const numberDirections: AntdOrder[] = ["descend", "ascend", "descend"];

// The header arrow for a column: lit only on the sorted one.
export function sortOrder<S extends string>(key: S, sort: S, dir: SortDir): AntdOrder | null {
  return sort === key ? (dir === "asc" ? "ascend" : "descend") : null;
}

// A header click writes the new sort to the URL. The table's column keys are the adapter's sort names.
export function onSortClick<T, S extends string>(sorts: readonly S[], defaultSort: S): TableProps<T>["onChange"] {
  return (_pagination, _filters, sorter) => {
    const picked = Array.isArray(sorter) ? sorter[0] : sorter;
    const next = picked?.order ? sorts.find((s) => s === picked.columnKey) : undefined;
    updateSearch(next ? sortChange(next, picked?.order === "ascend" ? "asc" : "desc", defaultSort) : sortChange(defaultSort, "desc", defaultSort));
  };
}

// A failed poll while the last answer still shows.
export function ErrorBanner({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="status" className="flex items-center gap-1.5 border-b border-line px-4 py-2 text-xs text-risk">
      <LuTriangleAlert size={12} className="shrink-0" aria-hidden />
      <span className="truncate">{error}</span>
    </p>
  );
}

// The pager under a table; page and size live in the URL.
export function TablePager({ page, pageSize, total }: { page: number; pageSize: number; total: number }) {
  if (total === 0) return null;
  return (
    <div className="flex justify-end border-t border-line px-4 py-3">
      <Pagination
        size="small"
        current={page}
        pageSize={pageSize}
        total={total}
        pageSizeOptions={pageSizes.map(String)}
        showSizeChanger
        showTotal={(all, [from, to]) => `${from}-${to} of ${all}`}
        onChange={(nextPage, nextSize) => updateSearch(pageChange(nextPage, nextSize, pageSize))}
      />
    </div>
  );
}
