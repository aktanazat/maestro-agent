export function pageCount(total, perPage) {
  // BUG: a partial last page is dropped; this needs Math.ceil, not Math.floor.
  return Math.floor(total / perPage);
}

export function pageSlice(items, page, perPage) {
  // BUG: pages are 1-indexed, so the start offset is (page - 1) * perPage, not page * perPage.
  const start = page * perPage;
  return items.slice(start, start + perPage);
}

export function hasNextPage(total, page, perPage) {
  return page < pageCount(total, perPage);
}
