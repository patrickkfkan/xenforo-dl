# xenforo-dl

A smal fork of [patrickkfkan/xenforo-dl](https://github.com/patrickkfkan/xenforo-dl) as [XenForo](https://xenforo.com/) forum downloader written in [Node.js](https://nodejs.org):

- Scrapes content from forum pages
- For each thread, downloads attachments and saves messages in text files
- Supports downloading a single thread or all threads in a forum
- Supports continuing from previous download

Since the downloader works through scraping, it is not guaranteed to work with all XenForo forums. I created the downloader for my data-hoarding needs targeting a handful of sites, so it might be limited in what it can scrape. But feel free to raise issues.


## Installation

First, install [Node.js](https://nodejs.org/).

Then, clone this repo and install dependencies:

```
npm install
```

Build the TypeScript sources (works on Windows, macOS and Linux):
```
npm run build
```

For browser mode and the browser integration tests, use Node.js 20 or newer and install the pinned Chromium browser:

```
npx playwright install chromium
```

Playwright is an optional dependency. Plain HTTP mode does not import it or launch a browser. If optional dependencies were omitted, install them with `npm install --include=optional` before using browser mode.

## Usage

```
node ./bin/xenforo-dl.js [OPTION]... URL
```
or link it globally:
```
npm link && xenforo-dl
```
### URL

#### Thread URLs

Pattern: `<forum_site_url>/threads/<title_slug>.<thread_id>[/page-<num>]`

Download all messages and attachments shown on page. If content spans multiple pages, download from subsequent pages as well.

If `page-<num>` is present in URL, then download will begin with the specified page.

#### Forum URLs

Pattern: `<forum_site_url>/forums/<title_slug>.<forum_id>[/page-<num>]`

Download all threads listed on page. If the forum has threads spanning multiple pages, download from subsequent pages as well.

If `page-<num>` is present in URL, then download will begin with the specified page.

#### Other URLs

For URLs not matching the above patterns, `xenforo-dl` will scrape for forum links and download from them. It is your responsibility to ensure the given URL is a valid XenForo link.

### Options

| Option    | Description |
|-----------|-------------|
| `-h`, `--help` | Display usage guide |
| `-k`, `--cookie` | Raw Cookie header or path to a file containing it. See [Cookies](#cookies). |
| `--browser` | Use a dedicated local, headed Chromium session for pages and attachments. Requires Node.js 20+ and Chromium installation. |
| `--browser-login` | Require authenticated XenForo content; allows manual login in the browser. Requires `--browser`. |
| `--browser-timeout` | Positive integer operation/login timeout in milliseconds. Default: 120000. Requires `--browser`. |
| `-o`, `--out-dir` | (string) Path of save directory. Default: current working directory. |
| `-d`, `--dir-structure` | Combination of flags controlling the output directory structure of downloaded threads: <ul><li>`s`: Include directory for the forum site.</li><li>`pl`: Include directory for each category or forum leading up to the target thread.</li><li>`pi`: Include directory for the immediate section or forum containing the target thread.</li><li>`t`: Include directory for the target thread itself.</li><li>`a`: Include directory for attachments.</li><li>`-`: No directory structure. Everything will be saved directly to --out-dir.</li></ul><p>Default: `splta`</p>|
| `-w`, `--overwrite` | Overwrite existing attachment files |
| `-l`, `--log-level` | Log level: `info`, `debug`, `warn` or `error`; set to `none`` to disable logging. Default: `info` |
| `-s`, `--log-file` | (string) Save logs to specified path |
| `-r`, `--max-retries` | (number) Maximum retry attempts when a download fails. Default: 3 |
| `-c`, `--max-concurrent`| (number) Maximum number of concurrent downloads for attachments. Default: 10 |
| `-p`, `--min-time-page` | (number) Minimum time, in milliseconds, to wait between page fetch requests. Default: 500 |
| `-i`, `--min-time-image` | (number) Minimum time, in milliseconds, to wait between download requests for attachments. Default: 200 |
| `--continue` | Continue from previous download |
| `-y`, `--no-prompt` | Do not prompt for confirmation to proceed |
| `-f`, `--filter-prefix` | (string) Filter threads by prefix|

### Cookies

Cookies allow you to download content that would otherwise be inaccessible due to lack of user credentials. To obtain a cookie for passing to `xenforo-dl` through the `--cookie` option, do the following:

1. In a browser, sign in to the target forum site.
2. Press `F12` to bring up Developer Tools.
3. Select `Network` tab, followed by `HTML` filter.
4. Press `F5` to refresh the page. Select one of the entries that appear under the `Network` tab.
5. Under `Headers` -> `Request Headers`, you should see the `Cookie` entry. 
6. Create a file name `cookie.txt` then pass parameter `-k ./cookie.txt` to the command.

The file must contain only the request-header value, for example `xf_user=...; xf_session=...`, not a `Cookie:` label, Netscape cookie table or JSON export. Without `--cookie`, cookie sources are checked in this order: `XENFORO_COOKIE`, `COOKIE`, then `cookie.txt` in the working directory. Raw headers do not preserve cookie expiry, path, SameSite or HttpOnly metadata. The site can invalidate a session before its apparent expiry.

### Browser mode for Cloudflare and login

For content your account is authorized to read:

```powershell
node ./bin/xenforo-dl.js --browser --browser-login --cookie ./cookie.txt --out-dir ./downloads "https://fuexam.me/threads/<actual-slug>.<actual-id>/"
```

Replace the example with a real thread URL. Do not begin with the site root for a small test: root discovery recursively downloads forums and threads.

The browser runs locally in an ephemeral, dedicated context. Cookies are scoped to the target site, never sent to a scraping service or set as a global browser header. Imported Cloudflare clearance cookies are not relied upon; the browser obtains its own challenge state. Use `--browser-login` for protected content so guest pages with hidden links cannot be mistaken for authenticated success. If cookies are absent or expired, log in or perform human verification in the visible browser before the timeout. No CAPTCHA solver or stealth patches are used, and acceptance by Cloudflare is not guaranteed.

HTML is obtained through Chromium navigation after the expected XenForo DOM appears. Attachments use Chromium's native download path, preserve binary bytes and are committed only after completion and validation. Browser operations are serialized even when `--max-concurrent` is higher. Browser mode may use attachment-ID filenames when no filename was present in the parsed page; it does not issue plain Node HTTP HEAD requests to prove browser access.

Browser mode rejects off-origin navigation/downloads rather than forwarding authentication to an untrusted destination. It may require temporary disk space for both the Chromium download and the `.part` destination. Press Ctrl+C to cancel; failed/cancelled files are not committed and incomplete messages do not advance continuation checkpoints. Sessions are not persisted between runs. Exit codes are 0 for success, 1 for failure/incomplete output and 130 for interruption.

Keep cookies, browser state and downloaded private content out of Git. Prefer `downloads/` (ignored) or an output directory outside the repository. Never paste credentials into an issue or PR. Automatic tests use synthetic cookies only.

### Tests

With Node.js 20+ and the pinned Chromium installed:

```
npm test
npm run lint
```

The tests use Node's standard test runner and real Chromium against loopback fixtures, not live accounts or external sites. They cover HTTP response/redirect safety, authenticated browser readiness, exact attachment bytes, cancellation, CLI outcomes and continuation. Live authenticated verification additionally requires a permitted thread, valid login and a real attachment; a passing fixture or public homepage is not proof of account access.

## Changelog

v1.0.0
- Initial release

## License

MIT
