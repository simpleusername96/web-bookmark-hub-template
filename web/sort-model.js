(function exposeSortModel(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WBHSortModel = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function sortModelFactory() {
  'use strict';

  const CRITERIA = Object.freeze([
    Object.freeze({ value: 'saved', label: 'Saved', ascending: 'oldest', descending: 'newest', ascendingLabel: 'Oldest', descendingLabel: 'Newest' }),
    Object.freeze({ value: 'updated', label: 'Edited', ascending: 'updated_asc', descending: 'updated_desc', ascendingLabel: 'Oldest', descendingLabel: 'Newest' }),
    Object.freeze({ value: 'title', label: 'Title', ascending: 'title_asc', descending: 'title_desc', ascendingLabel: 'A–Z', descendingLabel: 'Z–A' }),
    Object.freeze({ value: 'source', label: 'Source', ascending: 'source_asc', descending: 'source_desc', ascendingLabel: 'A–Z', descendingLabel: 'Z–A' })
  ]);

  function canonical(value) {
    const input = String(value || 'newest');
    if (input === 'title') return 'title_asc';
    return CRITERIA.some(function includes(criterion) {
      return input === criterion.ascending || input === criterion.descending;
    }) ? input : 'newest';
  }

  function describe(value) {
    const sort = canonical(value);
    const criterion = CRITERIA.find(function find(item) {
      return sort === item.ascending || sort === item.descending;
    });
    const direction = sort === criterion.ascending ? 'ascending' : 'descending';
    const directionLabel = direction === 'ascending' ? criterion.ascendingLabel : criterion.descendingLabel;
    return Object.freeze({
      sort,
      criterion: criterion.value,
      criterionLabel: criterion.label,
      direction,
      directionLabel,
      triggerLabel: criterion.label + ' ' + (direction === 'ascending' ? '↑' : '↓')
    });
  }

  function sortFor(criterionValue, direction) {
    const criterion = CRITERIA.find(function find(item) { return item.value === criterionValue; }) || CRITERIA[0];
    return direction === 'ascending' ? criterion.ascending : criterion.descending;
  }

  function defaultSortFor(criterionValue) {
    return sortFor(criterionValue, criterionValue === 'title' || criterionValue === 'source' ? 'ascending' : 'descending');
  }

  function opposite(value) {
    const current = describe(value);
    return sortFor(current.criterion, current.direction === 'ascending' ? 'descending' : 'ascending');
  }

  return { CRITERIA, canonical, defaultSortFor, describe, opposite, sortFor };
}));
