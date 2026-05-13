Prerequisites:
- bun
- docker
- tar
- latexpand
- pandoc
- ollama

1. Clone the repository

```bash
git clone git@github.com:RutamBhagat/arXiv7.git
cd arXiv7
```

2. Install dependencies

```bash
bun i
```

3. Start the database

```bash
cp apps/server/.env.example apps/server/.env
bun run db:start
bun run db:migrate
bun run db:studio
```

4. Start the dev server
- open a new terminal and run:

```bash
bun run dev
```
- use up and down arrows to navigate through the tui or server
- press `i` to enter insert mode in the tui for interacting with the chat box

5. Install ingestion dependecies locally

```bash
sudo apt install tar texlive-extra-utils pandoc
curl -fsSL https://ollama.com/install.sh | sh
# Note: the model size is 4.7 GB so depending on your internet speed this may take a while
ollama pull qwen3-embedding:8b
```

6. Ingest the papers
- arXiv api has heavy rate limits hence the process to automatically download the source zip file and extract the metadata can not be reliably automated
- hence the raw source zip files are stored in `apps/server/.ingest/raw/zip` and the required metadat is stored in `apps/server/.ingest/raw/metadata.json`
- to ingest the papers open a new terminal and run:

```bash
cd apps/server/.ingest/raw
./ingest.sh
```

- Note: Initially i was using `Gemini Embedding 2` model but on free tier it has heavy rate limits and was running out of daily quota mid way through embedding process
- ideally we should be using a cloud embedding model but in order to save costs I decided to go with the local `qwen3-embedding:8b` model, the biggest tradeoff for this is heavy local resource usage and much much slower ingestion times
- you can open a new browser tab and navigate to `https://local.drizzle.studio/` to see the ingested papers paper_docs, chunks search_text and embeddings along with the ingestion jobs that succeeded or failed or are currently in the middle of ingestion
- you can also use `btop` and `htop` to track the system resources being used by the resource intensive `ollama` and `pandoc` processes
- other useful commands
```bash
ollama ps
```
if the output is something like this, it means that ollama can not use your GPU and is using your CPU instead, and the hence the embedding will be much much slower
```bash
    NAME                  ID              SIZE      PROCESSOR    CONTEXT    UNTIL
    qwen3-embedding:8b    64b933495768    6.1 GB    100% CPU     4096       4 minutes from now
```
- `ollama` takes around 6GB of RAM with arund 4.5 GHz CPU and `pandoc` takes around 2GB of RAM
- it takes roughly around 2 minutes to ingest 1 paper so 50 papers would take around 100 minutes