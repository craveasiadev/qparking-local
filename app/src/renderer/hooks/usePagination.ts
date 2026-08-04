import { useCallback, useEffect, useState } from 'react';

/**
 * Page/offset state for a server-paged list — the pattern shared by the
 * Transactions and Sessions pages. The main process does the real
 * LIMIT/OFFSET query and returns { rows, total }; this hook owns the page
 * index, derives the offset to send with the query, and clamps the page back
 * into range when the total shrinks (a filter change or a deleted row can
 * leave the current page past the end — the clamp re-triggers the caller's
 * fetch effect because `page` is one of its dependencies).
 *
 * Usage:
 *   const pager = usePagination(PAGE_SIZE);
 *   // in fetchPage(): pass pager.offset, then pager.setTotal(result.total)
 *   // in the fetch effect deps: pager.page
 *   // on filter/search change: pager.reset()
 *   // footer: <PaginationBar pager={pager} rowsOnPage={rows.length} />
 */
export interface Pagination {
	page: number;
	setPage: React.Dispatch<React.SetStateAction<number>>;
	/** OFFSET to send with the current page's query. */
	offset: number;
	/** Total row count across all pages — feed each page response into setTotal. */
	total: number;
	setTotal: (n: number) => void;
	pageCount: number;
	pageSize: number;
	prev: () => void;
	next: () => void;
	/** Back to the first page — call whenever a filter or search term changes. */
	reset: () => void;
}

export function usePagination(pageSize: number): Pagination {
	const [page, setPage] = useState(0);
	const [total, setTotal] = useState(0);
	const pageCount = Math.max(1, Math.ceil(total / pageSize));

	// Clamp when the total shrinks under the current page.
	useEffect(() => {
		if (page > pageCount - 1) setPage(pageCount - 1);
	}, [page, pageCount]);

	const prev = useCallback(() => setPage((p) => Math.max(0, p - 1)), []);
	const next = useCallback(
		() => setPage((p) => Math.min(pageCount - 1, p + 1)),
		[pageCount],
	);
	const reset = useCallback(() => setPage(0), []);

	return {
		page,
		setPage,
		offset: page * pageSize,
		total,
		setTotal,
		pageCount,
		pageSize,
		prev,
		next,
		reset,
	};
}

/**
 * Client-side flavour of usePagination, for pages that already hold the full
 * (filtered) list in memory — the equipment pages (Cameras, Terminals, Lanes).
 * Slices the current page out of `items` and keeps the pager's total in sync,
 * so the shrink-clamp above also covers filters narrowing the list. Same
 * footer: <PaginationBar pager={pager} rowsOnPage={pageItems.length} />.
 * Callers still pager.reset() on filter/search changes so a new filter always
 * starts from page 1.
 */
export function usePagedList<T>(items: T[], pageSize: number): { pager: Pagination; pageItems: T[] } {
	const pager = usePagination(pageSize);
	const { setTotal } = pager;
	useEffect(() => {
		setTotal(items.length);
	}, [items.length, setTotal]);
	return { pager, pageItems: items.slice(pager.offset, pager.offset + pageSize) };
}
