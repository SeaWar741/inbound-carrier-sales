import { pageSizes } from "./contracts.ts";

// The adapter's default page size, which the URL never repeats.
export const defaultPageSize = 25;
export type SortDir = "asc" | "desc";

export type Paging<S extends string> = { sort: S; dir: SortDir; page: number; pageSize: number };

// Sort and paging as the URL holds them, defaults filled in; a value the adapter would refuse reads as the default.
export function paging<S extends string>(search: Pick<URLSearchParams, "get">, sorts: readonly S[], defaultSort: S): Paging<S> {
  const sort = sorts.find((s) => s === search.get("sort")) ?? defaultSort;
  const dir: SortDir = search.get("dir") === "asc" ? "asc" : "desc";
  const page = Number(search.get("page"));
  const pageSize = Number(search.get("pageSize"));
  return {
    sort,
    dir,
    page: Number.isInteger(page) && page > 1 ? page : 1,
    pageSize: (pageSizes as readonly number[]).includes(pageSize) ? pageSize : defaultPageSize,
  };
}

// The adapter query keys for sort and paging; defaults are left out.
export function setPaging<S extends string>(query: URLSearchParams, { sort, dir, page, pageSize }: Paging<S>, defaultSort: S) {
  if (sort !== defaultSort) query.set("sort", sort);
  if (dir === "asc") query.set("dir", "asc");
  if (page > 1) query.set("page", String(page));
  if (pageSize !== defaultPageSize) query.set("pageSize", String(pageSize));
}

// The URL changes for a new sort; defaults are dropped and the list starts again at page 1.
export function sortChange<S extends string>(sort: S, dir: SortDir, defaultSort: S): Record<string, string | null> {
  return { sort: sort === defaultSort ? null : sort, dir: dir === "asc" ? "asc" : null, page: null };
}

// The URL changes for a pager click: a new page size starts again at page 1.
export function pageChange(page: number, pageSize: number, currentPageSize: number): Record<string, string | null> {
  if (pageSize !== currentPageSize) return { pageSize: pageSize === defaultPageSize ? null : String(pageSize), page: null };
  return { page: page === 1 ? null : String(page) };
}
