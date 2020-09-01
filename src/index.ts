import axios from "axios";
import cheerio from "cheerio";
import url from "url";
import { execSync } from "child_process";
import fs from "fs";
import { strict as assert } from "assert";
import extractor from "tld-extract";

interface TLDInfo {
  tld: string;
  domain: string;
  sub: string; // Subdomain (can be the empty string)
}

interface TLDParseFn {
  (x: string | URL): TLDInfo;
}

const extractTLD: TLDParseFn = x => {
  return extractor(x, {
    allowPrivateTLD: true,
    allowUnknownTLD: true
  });
};

const debug = require("debug")("url-spider:main");

const HELP = `
-v, --verbose, --debug : Run in debug mode
--ignore <pattern>     : Ignore a URL pattern
-h, --help             : Print this help
`;

// NOTE Will fail if URL is malformed, which is what we want
const normalize = (url: string) => {
  return new URL(url).href;
};

const sleep = (ms: number, message = "") =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
    if (message) {
      debug(`[SLEEP ${ms}] ${message}`);
    }
  });

// Either i'm missing something or this is actually a hard problem. Using built
// in tools it's easy enough to check that the origin of two urls are the same.
// However, due to the nature of tlds it's much harder to say "is this a
// subdomain of that." For example. blog.iansinnott.com and iansinnott.com.
// Easy. In fact the transformation from the former to the latter could be done
// relatively simply, knowing that the URL has the form <sub>.<name>.<tld> but
// what about blog.iansinnott.com.tw? Well crap, how do we consistently match
// without ending up matching com.tw and saying a.com.tw is a subdomain of
// b.com.tw?
// NOTE The obvious option was to just use a dict, but I wasn't sure where one
// can reliably source all known TLDs. Moreover, all tlds is a moving target so
// without an effective algorithm there's essentially know way to ever have a
// stable lib that will just work
const similarOrigin = (a: string) => {
  const base = extractTLD(a);
  return (b: string) => {
    try {
      const x = extractTLD(b);
      const result = x.tld === base.tld && x.domain === base.domain;
      debug("similar", a, b, result);
      return result;
    } catch (err) {
      debug(err.message, `URL -> ${b}`);
      return false;
    }
  };
};

assert(similarOrigin("https://blog.iansinnott.com")("https://iansinnott.com"));
assert(
  similarOrigin("https://blog.iansinnott.com")("https://www.iansinnott.com")
);
assert(
  similarOrigin("https://www.github.com")("https://iansinnott.com") === false
);
assert(
  similarOrigin("https://blog.iansinnott.com?p=12#hash")(
    "https://iansinnott.com"
  )
);
assert(
  similarOrigin("https://blog.instagram.com")("https://iansinnott.com") ===
    false
);

const run = x => ({
  map: fn => run(fn(x)),
  val: () => x
});

const tap = <T = any>(fn: (x: T) => any) => (x: T): T => {
  fn(x);
  return x;
};

const main = async (baseUrl: string) => {
  console.error(`[INFO] Fetching for ${baseUrl}`);
  const hasSimilarOrigin = similarOrigin(baseUrl);
  const queue = [baseUrl];
  const visited = new Set<string>();
  const skipped = new Set<string>();
  const raw = new Set<string>();
  const invalid: any[][] = [];
  const sitemap: { [k: string]: Set<string> } = {};

  // Maybe allow a command line flag for this
  // FIXME
  while (queue.length) {
    // Given the length check we expect this to truly be a string
    const next = queue.shift() as string;

    // Skip
    if (visited.has(next)) {
      debug("[SKIP]", next);
      continue;
    }

    try {
      console.error(`[INFO] Dequeue <- ${next}`);

      // Shrink queue to ensure it will eventually be emptied
      const { data } = await axios.get(next);

      // It's important to add this now so we don't accidentally do a check
      // later _before_ we've added it. This controls whether or not we add a
      // URL onto the queue
      visited.add(next);

      // NOTE url.resolve handles absolute, relative, _and_ full urls
      // NOTE url.resolve seems to do some odd things under certain circumstances.
      //      For example: url.resolve('', 'http://stylus%E2%B8%BBlang.com/')
      //      This will insert an additional slash...
      const $ = cheerio.load(data);
      const pageLinks = run($("a"))
        .map(x => x.get()) // Don't use the cheerio pseudo array
        .map(xs => xs.map(x => $(x).attr("href"))) // Get all those hrefs
        .map(
          tap(xs => {
            xs.forEach(x => raw.add(x)); // Hold on to raw URLs for debugging normalization issues
          })
        )
        .map(xs => xs.map(x => normalize(url.resolve(next, x)))) // Normalize. See NOTE This is important
        .map(x => Array.from(new Set(x))) // Uniquify. No need to operate on duplicate links on a page
        .val();

      // Instantiate set if needed
      if (!sitemap[next]) sitemap[next] = new Set();

      for (const x of pageLinks) {
        sitemap[next].add(x); // Build sitemap

        // Either enqueue or
        if (hasSimilarOrigin(x)) {
          debug("[INFO] Enqueue ->", x);
          queue.push(x);
        } else {
          skipped.add(x);
        }
      }

      // Try not to bombard the server too hard
      // NOTE Since this isn't parallelized at all (yet) this is probably not
      // necessary
      await sleep(20);
    } catch (err) {
      console.error("[ERR]", err.message);
      invalid.push([err.response?.status || err.message, next]);
    }
  }

  // NOTE: Not yet appropriate for JSON, need Sets converted
  const stats = {
    invalid,
    visited,
    skipped,
    sitemap,
    raw
  };

  // Convert sets to arrays
  const converter = (_: string, v: any) => {
    return v instanceof Set ? Array.from(v) : v;
  };

  try {
    const tmpFile = execSync("mktemp", { encoding: "utf8" }).trim() + ".json";
    fs.writeFileSync(tmpFile, JSON.stringify(stats, converter, 2), {
      encoding: "utf8"
    });
    console.error("[INFO] Stats written to", tmpFile);
  } catch (err) {
    console.error("[ERR] Could not save stats. Aborting.");
    debug(err);
  }
};

if (require.main === module) {
  console.log("called from CLI");

  const baseUrl = normalize(process.argv[2]);

  main(baseUrl).then(console.error, console.error);
}

// main("https://iansinnott.com/").then(console.log, console.error);
