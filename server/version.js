'use strict';
/*
 * The one place the version is written down.
 *
 * There is no package.json and no build step, so nothing can derive this for
 * us — it is bumped by hand when something ships. Kept apart from the code
 * that uses it so that bumping it is a one-line diff with nothing else in it.
 *
 * API_VERSION is a different thing and moves far more slowly: it is the `v1`
 * in every route, and it changes only when a client that worked yesterday
 * would stop working today.
 */
module.exports = {
  VERSION: '0.1.0',
  API_VERSION: 1,
};
