import axios from "axios";
import cheerio from "cheerio";
import url from "url";

const debug = require("debug")("url-spider:index");

const sleep = (ms: number, message = "") =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
    if (message) {
      console.log(`[SLEEP ${ms}] ${message}`);
    }
  });

const similarOrigin = (a: string) => (b: string) => {
  const [ha, hb] = [a, b].map(x => new URL(x).host);
  const [shorter, longer] = [ha, hb].sort((a, b) => a.length - b.length);
  const result = shorter === longer || longer.includes(shorter);
  return result;
};

// debug(
//   similarOrigin("https://blog.iansinnott.com")("https://iansinnott.com"),
//   similarOrigin("https://blog.instagram.com")("https://iansinnott.com")
// );

interface Result {
  urls: string[];
  invalid: string[];
  skipped: string[];
}

// HACK Well, not really a hack but not great. I just want the clojure thread
// macros!
const run = x => ({
  map: fn => run(fn(x)),
  val: () => x
});

const main = async (baseUrl: string) => {
  debug(`Fetching for ${baseUrl}`);
  const hasSimilarOrigin = similarOrigin(baseUrl);
  const queue = [baseUrl];
  const visitted = new Set<string>();
  const discovered = new Set<string>();
  const result: Result = {
    urls: [],
    invalid: [],
    skipped: []
  };

  // Maybe allow a command line flag for this
  // FIXME
  const customPred = x => {
    return true;
    // return !x.includes("blog");
  };

  while (queue.length) {
    // Given the length check we expect this to truly be a string
    const next = queue.shift() as string;

    // Skip
    if (visitted.has(next)) {
      debug("[SKIP]", next);
      continue;
    }

    try {
      console.error(`[INFO] Fetch <- ${next}`);

      // Shrink queue to ensure it will eventually be emptied
      const { data } = await axios.get(next);

      // It's important to add this now so we don't accidentally do a check
      // later _before_ we've added it. This controls whether or not we add a
      // URL onto the queue
      visitted.add(next);

      const $ = cheerio.load(data);
      const pageLinks = run($("a"))
        .map(x => x.get()) // Don't use the cheerio pseudo array
        .map(xs => xs.map(x => $(x).attr("href")))
        .map(xs => xs.map(x => url.resolve(next, x)))
        .map(x => Array.from(new Set(x)))
        .val();

      // Push all links onto discovered
      pageLinks.forEach(x => {
        discovered.add(x);
      });

      const nextLinks = pageLinks.filter(hasSimilarOrigin).filter(customPred);
      const skipped = nextLinks.filter(x => !hasSimilarOrigin(x));

      await sleep(100);

      result.skipped = result.skipped.concat(skipped);
      nextLinks.forEach(x => {
        debug("[INFO] enqueue ->", x);
        queue.push(x);
      });
      debug(result, visitted);
      debug(queue);
    } catch (err) {
      console.error("[ERR]", err.message);
      result.invalid.push(next);
    }
  }

  return {
    ...result,
    visited: Array.from(visitted),
    discovered: Array.from(discovered)
  };
};

if (require.main === module) {
  debug("[INFO] called from CLI");
  main(process.argv[2]).then(debug, console.warn);
}

// main("https://iansinnott.com/").then(console.log, console.error);
