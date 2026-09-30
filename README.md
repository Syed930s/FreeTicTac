# FreeTicTac

Open source, charityware multiplayer Tic-Tac-Toe. Runs entirely on Cloudflare: static frontend on Pages, game API on Pages Functions, state in Workers KV.

## Stack

- **Frontend:** static site served from `public/`
- **Backend:** Cloudflare Pages Functions (`functions/`)
- **Storage:** Workers KV, bound as `STORE`
- **Tooling:** Wrangler

## Project layout

```
FreeTicTac/
├── functions/       # Pages Functions (API routes)
├── public/          # Static frontend (Pages build output)
├── package.json
├── wrangler.toml
└── .gitignore
```

## Run locally

Requires Node.js and npm.

```bash
git clone https://github.com/syed930s/FreeTicTac.git
cd FreeTicTac
npm install
npm run dev
```

`npm run dev` runs `wrangler pages dev public` and serves the site with Functions locally. Local KV is emulated by Wrangler.

## Deploy

1. Create a KV namespace:
   ```bash
   npx wrangler kv namespace create STORE
   ```
2. Put the returned ID in `wrangler.toml`:
   ```toml
   [[kv_namespaces]]
   binding = "STORE"
   id = "<your-namespace-id>"
   ```
3. Deploy:
   ```bash
   npm run deploy        # preview
   npm run deploy:prod   # production (main branch)
   ```

The Pages project name is `freetictac`. Change it in the `package.json` scripts if you deploy under a different name.

## Charityware

FreeTicTac is free to use, modify, and host. If you find it useful, please donate to a charity of your choice.

## Contributing

Issues and PRs are welcome.

1. Fork the repo
2. Create a branch
3. Open a pull request against `main`

## License

ISC. See `package.json`.

## Author

Syed Shah — [@syed930s](https://github.com/syed930s)
