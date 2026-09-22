(function (root, factory) {
  var createDemoSource = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = createDemoSource;
  }
  root.createDemoSource = createDemoSource;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // This in-memory adapter mirrors registry-facing I/O shapes for UI evaluation.
  // Production browser code must replace the factory; this file is not a policy owner.

  var DEMO_NOW = Date.parse('2026-08-28T12:00:00.000Z');
  var KINDS = ['page', 'article', 'post', 'research', 'code', 'image', 'video'];
  var VISIBILITIES = ['normal', 'private'];

  function mirrorsForVisibility(visibility) {
    return visibility === 'normal'
      ? { agent_access: 'allowed', ai_processing: 'enabled' }
      : { agent_access: 'blocked', ai_processing: 'disabled' };
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  async function selectionDigest(items) {
    var ids = items.map(function (item) { return String(item.id); }).sort();
    var bytes = new TextEncoder().encode(JSON.stringify(ids));
    var digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(function (value) { return value.toString(16).padStart(2, '0'); }).join('');
  }

  function normalizedTag(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
  }

  function tagObject(value, addedAt) {
    if (typeof value === 'object' && value !== null) {
      var existingName = String(value.name || value.normalized_name || '').replace(/\s+/g, ' ').trim();
      var existingNormalized = normalizedTag(value.normalized_name || existingName);
      if (!existingNormalized) return null;
      return {
        id: value.id || 'tag-' + existingNormalized.replace(/\s+/g, '-'),
        name: existingName || existingNormalized,
        normalized_name: existingNormalized,
        added_at: value.added_at || addedAt
      };
    }
    var name = String(value || '').replace(/\s+/g, ' ').trim();
    var normalized = normalizedTag(name);
    return normalized ? { id: 'tag-' + normalized.replace(/\s+/g, '-'), name: name, normalized_name: normalized, added_at: addedAt } : null;
  }

  function uniqueTagObjects(values, addedAt) {
    var seen = new Set();
    return (values || []).map(function (tag) {
      return tagObject(tag, addedAt);
    }).filter(function (tag) {
      if (!tag || seen.has(tag.normalized_name)) return false;
      seen.add(tag.normalized_name);
      return true;
    });
  }

  function normaliseEntry(input) {
    var item = clone(input);
    item.tags = uniqueTagObjects(item.tags, item.saved_at);
    item.typed_metadata = item.typed_metadata || {};
    item.comment_count = Number(item.comment_count || 0);
    item.snapshot_count = Number(item.snapshot_count || 0);
    item.summary_job_count = Number(item.summary_job_count || 0);
    return item;
  }

  function parseDemoUrl(value) {
    var parsed;
    try {
      parsed = new URL(String(value || '').trim());
    } catch (error) {
      throw new TypeError('A valid http or https URL is required.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new TypeError('A valid http or https URL is required.');
    }
    if (parsed.username || parsed.password) {
      throw new TypeError('URLs containing credentials are not supported.');
    }
    return parsed;
  }

  // Demo-only display normalization. A production adapter must use the registry's
  // canonical URL, provider, kind, and policy outputs instead of reusing this logic.
  function demoCanonicalUrl(parsed) {
    var copy = new URL(parsed.href);
    copy.hash = '';
    return copy.href;
  }

  function compareEntries(sort) {
    return function (left, right) {
      if (sort === 'title_asc' || sort === 'title_desc') {
        var leftTitle = String(left.title || left.url_original || '');
        var rightTitle = String(right.title || right.url_original || '');
        var titleResult = leftTitle.localeCompare(rightTitle);
        if (sort === 'title_desc') titleResult *= -1;
        return titleResult || (sort === 'title_desc' ? right.id.localeCompare(left.id) : left.id.localeCompare(right.id));
      }
      if (sort === 'source_asc' || sort === 'source_desc') {
        var sourceDirection = sort === 'source_desc' ? -1 : 1;
        return sourceDirection * String(left.source_domain || '').localeCompare(String(right.source_domain || ''))
          || sourceDirection * String(left.title || left.url_original || '').localeCompare(String(right.title || right.url_original || ''))
          || sourceDirection * left.id.localeCompare(right.id);
      }
      var timeField = sort === 'updated_desc' || sort === 'updated_asc' ? 'record_updated_at' : 'saved_at';
      var leftTime = Date.parse(left[timeField]);
      var rightTime = Date.parse(right[timeField]);
      var ascending = sort === 'oldest' || sort === 'updated_asc';
      var result = ascending ? leftTime - rightTime : rightTime - leftTime;
      return result || (ascending ? left.id.localeCompare(right.id) : right.id.localeCompare(left.id));
    };
  }

  function hasRenderableCover(item) {
    var cover = item && item.cover_image;
    return Boolean(cover && (
      (cover.storage_kind === 'local' && cover.status === 'ready')
      || (cover.storage_kind === 'remote' && cover.status === 'referenced')
    ));
  }

  function createDemoSource(initialEntries) {
    var entries = (initialEntries || []).map(normaliseEntry);
    var comments = new Map();
    var revisions = new Map();
    var capturePolicy = { visibility: 'private', agent_access: 'blocked', ai_processing: 'disabled' };
    var policyRules = [];
    var nextId = entries.length + 1;

    entries.forEach(function (item) {
      comments.set(item.id, []);
      revisions.set(item.id, [{
        id: item.id + '-revision-1', entry_id: item.id, revision_number: 1, action: 'created',
        actor_type: 'system', actor_id: 'demo', changes: { baseline: { before: null, after: true } },
        created_at: item.record_created_at || item.saved_at
      }]);
    });

    function matchedBySearch(item, search) {
      if (!search) return true;
      var haystack = [item.title, item.url_original, item.url_canonical, item.source_domain, item.provider]
        .concat(item.tags.map(function (itemTag) { return itemTag.name + ' ' + itemTag.normalized_name; }))
        .join(' ')
        .toLowerCase();
      return haystack.indexOf(search) !== -1;
    }

    function entryForOutput(item) {
      var output = clone(item);
      output.comment_count = (comments.get(item.id) || []).length;
      return output;
    }

    function matchingEntries(query) {
      var options = query || {};
      var search = String(options.search || '').trim().toLowerCase();
      var sort = ['newest', 'oldest', 'updated_desc', 'updated_asc', 'title_asc', 'title_desc', 'source_asc', 'source_desc'].indexOf(options.sort) >= 0
        ? options.sort
        : options.sort === 'title' ? 'title_asc' : 'newest';
      return entries.filter(function (item) {
        if (item.deleted_at) return false;
        if (!matchedBySearch(item, search)) return false;
        if (options.preview === 'with' && !hasRenderableCover(item)) return false;
        if (options.preview === 'without' && hasRenderableCover(item)) return false;
        if (options.kind && item.kind !== options.kind) return false;
        if (options.provider && item.provider !== options.provider) return false;
        if (options.source_domain && item.source_domain !== String(options.source_domain).toLowerCase()) return false;
        if (options.visibility && item.visibility !== options.visibility) return false;
        if (options.agent_access && item.agent_access !== options.agent_access) return false;
        if (options.content_focus && item.content_focus !== options.content_focus) return false;
        if (options.folder_id !== undefined && item.folder_id !== Number(options.folder_id)) return false;
        if (options.tag && !item.tags.some(function (tag) { return tag.normalized_name === normalizedTag(options.tag); })) return false;
        if (options.saved_from && Date.parse(item.saved_at) < Date.parse(options.saved_from)) return false;
        if (options.saved_to) {
          var savedTo = Date.parse(options.saved_to);
          if (/^\d{4}-\d{2}-\d{2}$/.test(String(options.saved_to))) savedTo += 24 * 60 * 60 * 1000 - 1;
          if (Date.parse(item.saved_at) > savedTo) return false;
        }
        return true;
      }).sort(compareEntries(sort));
    }

    return {
      baseUrl: 'demo://synthetic/',
      initialize: async function () {
        return {
          service: { api_version: 1, schema_version: 6, capabilities: { permanent_delete: true } },
          session: { csrf_token: 'demo', expires_at: null }
        };
      },
      getServiceInfo: async function () {
        return { api_version: 1, schema_version: 6, capabilities: { permanent_delete: true } };
      },
      listEntries: async function (query) {
        var options = query || {};
        var page = Math.max(1, Number.parseInt(options.page, 10) || 1);
        var pageSize = Math.max(1, Math.min(100, Number.parseInt(options.page_size, 10) || 12));
        var filtered = matchingEntries(options);
        var total = filtered.length;
        var totalPages = Math.ceil(total / pageSize);
        var effectivePage = totalPages ? Math.min(page, totalPages) : 1;
        var offset = (effectivePage - 1) * pageSize;
        return {
          items: filtered.slice(offset, offset + pageSize).map(entryForOutput),
          page: effectivePage,
          page_size: pageSize,
          total: total,
          total_pages: totalPages
        };
      },

      getEntry: async function (id) {
        var found = entries.find(function (item) { return item.id === id; });
        return found ? entryForOutput(found) : null;
      },

      topTags: async function (options) {
        var limit = Math.max(1, Number.parseInt((options || {}).limit, 10) || 5);
        var counts = new Map();
        entries.forEach(function (item) {
          item.tags.forEach(function (itemTag) {
            var current = counts.get(itemTag.normalized_name) || { id: itemTag.id, name: itemTag.name, normalized_name: itemTag.normalized_name, entry_count: 0 };
            current.entry_count += 1;
            counts.set(itemTag.normalized_name, current);
          });
        });
        return Array.from(counts.values()).sort(function (left, right) {
          return right.entry_count - left.entry_count || left.name.localeCompare(right.name);
        }).slice(0, limit).map(clone);
      },

      selectionSnapshot: async function (query) {
        var matched = matchingEntries(query);
        return {
          expected_count: matched.length,
          expected_digest: await selectionDigest(matched)
        };
      },

      suggestTags: async function (options) {
        var settings = options || {};
        var query = normalizedTag(settings.query || '');
        if (!query) return [];
        var excluded = new Set((settings.exclude || []).map(normalizedTag));
        var tags = await this.topTags({ limit: 100 });
        return tags.filter(function (tag) {
          return tag.normalized_name.includes(query) && !excluded.has(tag.normalized_name);
        }).sort(function (left, right) {
          var leftPrefix = left.normalized_name.startsWith(query) ? 0 : 1;
          var rightPrefix = right.normalized_name.startsWith(query) ? 0 : 1;
          return leftPrefix - rightPrefix || right.entry_count - left.entry_count || left.normalized_name.localeCompare(right.normalized_name);
        }).slice(0, Math.min(8, Number(settings.limit) || 8)).map(clone);
      },

      topSourceDomains: async function (options) {
        var settings = options || {};
        var limit = Math.max(1, Number.parseInt(settings.limit, 10) || 5);
        var threshold = Math.max(1, Number.parseInt(settings.threshold, 10) || 3);
        var counts = new Map();
        entries.forEach(function (item) {
          counts.set(item.source_domain, (counts.get(item.source_domain) || 0) + 1);
        });
        return Array.from(counts.entries()).map(function (pair) {
          return { source_domain: pair[0], entry_count: pair[1] };
        }).filter(function (item) {
          return item.entry_count >= threshold;
        }).sort(function (left, right) {
          return right.entry_count - left.entry_count || left.source_domain.localeCompare(right.source_domain);
        }).slice(0, limit).map(clone);
      },
      listFolders: async function () { return []; },
      listUrlGroups: async function () { return []; },
      listClients: async function () { return []; },
      createPairingCode: async function () {
        return { code: 'DEMO-CODE', expires_at: '2026-08-28T12:05:00.000Z' };
      },
      revokeClient: async function () { return null; },
      listEntryRevisions: async function (entryId) { return clone(revisions.get(entryId) || []); },
      listVisualAssets: async function () { return []; },
      setCover: async function () { return null; },
      clearCover: async function () { return []; },
      removeVisualAsset: async function () { return null; },
      editEntry: async function (entryId, changes) {
        var item = entries.find(function (candidate) { return candidate.id === entryId; });
        if (!item || item.deleted_at) throw new RangeError('Entry not found.');
        var before = clone(item);
        if (Object.prototype.hasOwnProperty.call(changes, 'url')) {
          var parsed = parseDemoUrl(changes.url);
          item.url_original = changes.url;
          item.url_canonical = demoCanonicalUrl(parsed);
          item.source_domain = parsed.hostname.toLowerCase();
        }
        if (Object.prototype.hasOwnProperty.call(changes, 'title')) item.title = changes.title;
        if (Object.prototype.hasOwnProperty.call(changes, 'tags')) item.tags = uniqueTagObjects(changes.tags, NOW_STRING);
        if (Object.prototype.hasOwnProperty.call(changes, 'folder_id')) item.folder_id = changes.folder_id;
        ['kind', 'content_focus', 'visibility'].forEach(function assign(field) {
          if (Object.prototype.hasOwnProperty.call(changes, field)) item[field] = changes[field];
        });
        if (Object.prototype.hasOwnProperty.call(changes, 'visibility')) Object.assign(item, mirrorsForVisibility(item.visibility));
        item.record_updated_at = NOW_STRING;
        appendDemoRevision(item, before, 'updated');
        return entryForOutput(item);
      },
      deleteEntry: async function (entryId) {
        var index = entries.findIndex(function (candidate) { return candidate.id === entryId; });
        if (index < 0) throw new RangeError('Entry not found.');
        entries.splice(index, 1);
        revisions.delete(entryId);
        return { deleted: 1, entry_ids: [entryId], files_removed: 0, files_missing: 0 };
      },
      batchEntries: async function batchEntries(input) {
        var matched = input.query ? matchingEntries(input.query) : entries.filter(function selected(entry) {
          return (input.entry_ids || []).map(String).includes(String(entry.id));
        });
        if (input.query && (matched.length !== input.expected_count || await selectionDigest(matched) !== input.expected_digest)) {
          throw new Error('The result set changed. Review it and try again.');
        }
        var ids = new Set(matched.map(function id(entry) { return String(entry.id); }));
        var changed = 0;
        entries.forEach(function apply(entry) {
          if (!ids.has(String(entry.id))) return;
          if (input.operation === 'delete') { changed += 1; return; }
          else if (input.operation === 'set_folder') entry.folder_id = input.value.folder_id;
          else if (input.operation === 'set_kind') {
            entry.kind = input.value.kind;
            entry.kind_source = 'user';
          }
          else if (input.operation === 'set_content_focus') entry.content_focus = input.value.content_focus;
          else if (input.operation === 'set_policy') {
            Object.assign(entry, input.value);
            if (input.value.visibility) Object.assign(entry, mirrorsForVisibility(input.value.visibility));
          }
          else if (input.operation === 'add_tags') entry.tags = Array.from(new Set([...(entry.tags || []).map(function name(tag) { return tag.name || tag; }), ...input.value.tags])).map(function tag(name) { return { name: name, normalized_name: name.toLowerCase() }; });
          else if (input.operation === 'remove_tags') entry.tags = (entry.tags || []).filter(function keep(tag) { return !input.value.tags.map(function lower(name) { return name.toLowerCase(); }).includes((tag.name || tag).toLowerCase()); });
          changed += 1;
        });
        if (input.operation === 'delete') {
          for (var index = entries.length - 1; index >= 0; index -= 1) {
            if (ids.has(String(entries[index].id))) entries.splice(index, 1);
          }
        }
        return { operation: input.operation, matched: ids.size, changed: changed, entries: entries.filter(function selected(entry) { return ids.has(String(entry.id)); }) };
      },
      getCapturePolicy: async function () { return clone(capturePolicy); },
      updateCapturePolicy: async function (policy) {
        capturePolicy = Object.assign({}, capturePolicy, policy);
        if (policy.visibility) Object.assign(capturePolicy, mirrorsForVisibility(policy.visibility));
        return clone(capturePolicy);
      },
      listCapturePolicyRules: async function () { return clone(policyRules); },
      createCapturePolicyRule: async function (rule) {
        var parsed = parseDemoUrl(rule.url_prefix);
        var created = {
          id: policyRules.length + 1,
          hostname: parsed.hostname,
          path_prefix: parsed.pathname,
          kind: rule.kind || null,
          capture_mode: rule.capture_mode || 'all',
          visibility: rule.visibility,
          ...mirrorsForVisibility(rule.visibility),
          enabled: true,
          position: policyRules.length
        };
        policyRules.push(created);
        return clone(created);
      },
      updateCapturePolicyRule: async function (id, changes) {
        var rule = policyRules.find(function (candidate) { return candidate.id === Number(id); });
        if (Object.prototype.hasOwnProperty.call(changes, 'url_prefix')) {
          var parsed = parseDemoUrl(changes.url_prefix);
          changes = Object.assign({}, changes, { hostname: parsed.hostname, path_prefix: parsed.pathname });
          delete changes.url_prefix;
        }
        Object.assign(rule, changes);
        if (changes.visibility) Object.assign(rule, mirrorsForVisibility(changes.visibility));
        return clone(rule);
      },
      deleteCapturePolicyRule: async function (id) {
        policyRules = policyRules.filter(function (candidate) { return candidate.id !== Number(id); });
        return null;
      },
      previewCapturePolicyRule: async function () { return { match_count: 0, entry_ids: [] }; },
      applyCapturePolicyRule: async function () { return { updated_count: 0, entry_ids: [] }; },

      addEntry: async function (draft) {
        var input = draft || {};
        var parsed = parseDemoUrl(input.url_original || input.url);
        var canonical = demoCanonicalUrl(parsed);
        var existing = entries.find(function (candidate) { return candidate.url_canonical === canonical; });
        if (existing) return { entry: entryForOutput(existing), outcome_code: 'already_saved' };
        var now = NOW_STRING;
        var kind = KINDS.indexOf(input.kind) >= 0 ? input.kind : 'page';
        var requestedVisibility = input.visibility;
        var visibility = VISIBILITIES.indexOf(requestedVisibility) >= 0 ? requestedVisibility : 'private';
        var mirrors = mirrorsForVisibility(visibility);
        var title = String(input.title || '').trim() || null;
        var item = {
          id: 'demo-' + String(nextId++).padStart(3, '0'),
          url_original: String(input.url_original || input.url).trim(),
          url_canonical: canonical,
          title: title,
          kind: kind,
          kind_source: input.kind_source || 'manual',
          provider: input.provider || parsed.hostname,
          source_domain: parsed.hostname.toLowerCase(),
          typed_metadata: clone(input.typed_metadata || { label: kind, preview_tone: 'paper' }),
          saved_at: now,
          published_at: input.published_at || null,
          updated_at: now,
          visibility: visibility,
          agent_access: mirrors.agent_access,
          ai_processing: mirrors.ai_processing,
          content_focus: input.contentFocus || input.content_focus || 'text',
          record_created_at: now,
          record_updated_at: now,
          tags: uniqueTagObjects(input.tags, now),
          comment_count: 0,
          snapshot_count: 0,
          summary_job_count: 0
        };
        entries.push(item);
        comments.set(item.id, []);
        revisions.set(item.id, [{
          id: item.id + '-revision-1', entry_id: item.id, revision_number: 1, action: 'created',
          actor_type: 'user', changes: { baseline: { before: null, after: true } }, created_at: now
        }]);
        return { entry: entryForOutput(item), outcome_code: 'created' };
      },

      addComment: async function (entryId, body) {
        var item = entries.find(function (candidate) { return candidate.id === entryId; });
        var text = String(body || '').trim();
        if (!item) throw new RangeError('Entry not found.');
        if (!text) throw new TypeError('A comment body is required.');
        var itemComments = comments.get(entryId);
        var comment = {
          id: entryId + '-comment-' + String(itemComments.length + 1).padStart(3, '0'),
          entry_id: entryId,
          body: text,
          created_at: NOW_STRING
        };
        itemComments.push(comment);
        item.comment_count = itemComments.length;
        item.record_updated_at = NOW_STRING;
        return clone(comment);
      },

      listComments: async function (entryId, options) {
        var settings = options || {};
        var page = Math.max(1, Number.parseInt(settings.page, 10) || 1);
        var pageSize = Math.max(1, Math.min(100, Number.parseInt(settings.page_size, 10) || 20));
        var allComments = entries.some(function (candidate) { return candidate.id === entryId; })
          ? comments.get(entryId) || []
          : [];
        var total = allComments.length;
        return {
          items: clone(allComments.slice((page - 1) * pageSize, page * pageSize)),
          page: page,
          page_size: pageSize,
          total: total,
          total_pages: Math.ceil(total / pageSize)
        };
      }
    };

    function appendDemoRevision(item, before, action) {
      var list = revisions.get(item.id) || [];
      list.unshift({
        id: item.id + '-revision-' + (list.length + 1),
        entry_id: item.id,
        revision_number: list.length + 1,
        action: action,
        actor_type: 'user',
        changes: { demo: { before: before.record_updated_at, after: item.record_updated_at } },
        created_at: NOW_STRING
      });
      revisions.set(item.id, list);
    }
  }

  var NOW_STRING = '2026-08-28T12:00:00.000Z';
  return createDemoSource;
}));
