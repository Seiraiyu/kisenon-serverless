# @kisenon/serverless

Serverless/edge Postgres client for kisenon — a drop-in `@neondatabase/serverless` swap over HTTP and WebSocket, from Node, Cloudflare Workers, Deno, Bun, and Vercel Edge.

```sh
npm i @kisenon/serverless
```

```ts
import { neon } from "@kisenon/serverless";

const sql = neon(process.env.DATABASE_URL!);
const rows = await sql`SELECT ${1} AS n`;
console.log(rows); // [{ n: 1 }]
```
