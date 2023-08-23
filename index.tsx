import { ServeOptions } from "bun";
import { Database } from "bun:sqlite";
import { differenceInMinutes } from "date-fns";
import { PropsWithChildren } from "react";
import { renderToString } from "react-dom/server";

const db = new Database(process.env.DB || "./valtown.db");
db.run(
  "create virtual table if not exists vals using fts5(id, handle, name, split_name, code)"
);

interface Val {
  id: string;
  handle: string;
  name: string;
  split_name: string;
  code: string;
}
const deleteVal = db.query("delete from vals where id = ?");
const insertVal = db.query(
  "insert into vals(id, handle, name, split_name, code) values (?, ?, ?, ?, ?)"
);
const searchVals = db.query<Val, string>("select * from vals where vals = ? order by rank desc");

const isCamelcase = (s: string) => s.match(/[a-z0-9][A-Z]/g)
const isSnakecase = (s: string) => s.match(/\w_\w/g);
const isKebabcase = (s: string) => s.match(/\w-\w/g);
const transformName = (s: string) => {
  if (isCamelcase(s)) return s.replace(/[A-Z]/g, s => ` ${s}`)
  if (isSnakecase(s)) return s.replace(/_/g, " ")
  if (isKebabcase(s)) return s.replace(/-/g, " ")
}

let populating = false;
let lastPopulated: Date;
const populateVals = async () => {
  let next = `https://api.val.town/v1/search/vals?query=%20&offset=0&limit=100`;
  try {
    populating = true;
    while (next) {
      try {
        console.info(`Fetching ${next}`);
        const response = await fetch(next);
        const json = await response.json();
        const { links, data } = json;
        next = links.next;
        for (const val of data) {
          deleteVal.run(val.id);
          insertVal.run(val.id, val.author.username, val.name, transformName(val.name), val.code);
        }
        console.info(`Inserted ${data.length} vals`);
      } catch (err) {
        console.error(err);
        continue;
      }
      lastPopulated = new Date();
    }
  } finally {
    populating = false;
  }
};

function Layout({ children }: PropsWithChildren) {
  return (
    <html>
      <head>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/water.css@2/out/water.css"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
function HomePage({ q, results }: { q?: string; results?: Val[] }) {
  const anyResults = (results?.length || 0) > 0;

  return (
    <Layout>
      <main>
        <h1>Val Town Search</h1>
        <form action="/" method="get">
          <label htmlFor="q">
            Query
            <input
              type="text"
              name="q"
              id="q"
              autoComplete="off"
              defaultValue={q}
            />
          </label>
        </form>
        {anyResults ? (
          <article>
            <h2>Search Results</h2>
            <ol
              style={{ display: "flex", flexDirection: "column", gap: "1rem" }}
            >
              {results?.map((val) => (
                <li key={val.id}>
                  <Val val={val} />
                </li>
              ))}
            </ol>
          </article>
        ) : null}
      </main>
    </Layout>
  );
}

function Val({ val }: { val: Val }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: "auto 1fr",
        padding: "1rem",
        boxShadow: "#00000030 4px 4px 8px",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: "1rem",
          alignItems: "center",
        }}
      >
        <a href={`http://val.town/v/${val.handle}.${val.name}`}>
          {val.handle}.{val.name}
        </a>
      </div>
      <div>
        <pre>
          {val.code}
        </pre>
      </div>
    </div>
  );
}

const handleFetch: ServeOptions["fetch"] = async (request, server) => {
  const url = new URL(request.url);
  if (url.pathname === "/") {
    const q = url.searchParams.get("q") || undefined;
    const results = q ? searchVals.all(q) : [];
    return new Response(renderToString(<HomePage q={q} results={results} />), {
      headers: { "Content-Type": "text/html" },
    });
  }
  if (url.pathname === "/sync") {
    const lastSynced = lastPopulated
      ? differenceInMinutes(lastPopulated, new Date())
      : 9999;
    const syncedAWhileAgo = lastSynced > 60;
    if (!populating && syncedAWhileAgo) populateVals();
    return new Response("Populating...");
  }

  return new Response("Not found", { status: 404 });
};

const server = Bun.serve({ fetch: handleFetch, port: process.env.PORT || 3434 });
process.on("exit", () => server.stop());
