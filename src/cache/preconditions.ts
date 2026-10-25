import { EntityTag, parseEntityTagList, weakMatch } from './etag.js';
import { parseHttpDate } from './http-date.js';

export interface ClientConditionalsInput {
  method?: string;
  ifNoneMatch?: string | string[];
  ifModifiedSince?: string | string[];
}

export interface EntryValidators {
  etag?: EntityTag;
  lastModifiedMs?: number;
}

export interface ConditionalsResult {
  outcome: 'not_modified' | 'proceed';
  reason: string;
}

/**
 * Evaluates client preconditions (If-None-Match, If-Modified-Since) against stored entry validators.
 * Pure function: (request, validators) -> { outcome, reason }
 *
 * Rules per RFC 9110 Sections 13.1.2, 13.1.3, 13.2.2:
 * 1. Only GET method is evaluated; other methods return proceed.
 * 2. If-None-Match takes precedence:
 *    - absent: no decision from INM, check IMS.
 *    - "*": not_modified (entry exists).
 *    - valid tag list: not_modified if entry has a usable etag and ANY listed tag weak-matches; else proceed.
 *    - valid tag list with entry that has no etag: proceed.
 *    - invalid / unparseable tag list: proceed (conservative: send 200).
 * 3. If-Modified-Since is evaluated ONLY when If-None-Match is ABSENT:
 *    - any If-None-Match (even invalid or empty tag list) disables If-Modified-Since.
 *    - exactly one valid HTTP date (IMF-fixdate, RFC 850, or asctime), and entry has lastModifiedMs:
 *      not_modified if lastModifiedMs <= ifModifiedSinceMs, else proceed.
 *    - missing, multiple, or invalid date, or entry has no lastModifiedMs: proceed.
 */
export function evaluateClientConditionals(
  req: ClientConditionalsInput,
  validators: EntryValidators
): ConditionalsResult {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    return { outcome: 'proceed', reason: 'method_not_get' };
  }

  // 1. Evaluate If-None-Match if present
  if (req.ifNoneMatch !== undefined) {
    const parsed = parseEntityTagList(req.ifNoneMatch);
    if (parsed.kind === 'invalid') {
      // Any malformed tag list causes If-None-Match to evaluate to false (proceed),
      // and disables If-Modified-Since per RFC 9110 Section 13.1.3.
      return { outcome: 'proceed', reason: 'if_none_match_invalid' };
    }

    if (parsed.kind === 'star') {
      return { outcome: 'not_modified', reason: 'if_none_match_star' };
    }

    if (parsed.kind === 'tags') {
      if (!validators.etag) {
        return { outcome: 'proceed', reason: 'no_stored_etag' };
      }
      for (const tag of parsed.tags) {
        if (weakMatch(tag, validators.etag)) {
          return { outcome: 'not_modified', reason: 'if_none_match_match' };
        }
      }
      return { outcome: 'proceed', reason: 'if_none_match_no_match' };
    }
  }

  // 2. Evaluate If-Modified-Since ONLY when If-None-Match is ABSENT
  if (req.ifModifiedSince !== undefined) {
    let count = 0;
    let rawIms = '';
    if (Array.isArray(req.ifModifiedSince)) {
      count = req.ifModifiedSince.length;
      rawIms = req.ifModifiedSince[0];
    } else {
      count = 1;
      rawIms = req.ifModifiedSince;
    }

    if (count !== 1) {
      return { outcome: 'proceed', reason: 'if_modified_since_multiple' };
    }

    const imsDateMs = parseHttpDate(rawIms);
    if (imsDateMs === null) {
      return { outcome: 'proceed', reason: 'if_modified_since_invalid' };
    }

    if (validators.lastModifiedMs === undefined) {
      return { outcome: 'proceed', reason: 'no_stored_last_modified' };
    }

    // RFC 9110 Section 13.1.3:
    // If the selected representation's last modification date is earlier or equal to the condition date,
    // the condition is false -> not_modified.
    if (validators.lastModifiedMs <= imsDateMs) {
      return { outcome: 'not_modified', reason: 'if_modified_since_not_modified' };
    } else {
      return { outcome: 'proceed', reason: 'if_modified_since_modified' };
    }
  }

  return { outcome: 'proceed', reason: 'no_conditionals' };
}
