FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310 DATABASE_PATH=/data/opendots.sqlite
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && mkdir -p /data && chown node:node /data
COPY --from=build /app/dist ./dist
USER node
EXPOSE 4310
CMD ["node", "dist/server/server/index.js"]

FROM quay.io/docling-project/docling-serve-cpu:latest AS docling
# The hybrid chunker's tokenizer is not in the image and would be fetched from
# Hugging Face on first use; the service runs on a network without internet.
RUN python -c "from docling_core.transforms.chunker.tokenizer.huggingface import HuggingFaceTokenizer; HuggingFaceTokenizer.from_pretrained(model_name='sentence-transformers/all-MiniLM-L6-v2')"
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1

FROM node:24-bookworm-slim AS browser
ENV NODE_ENV=production BROWSER_HOST=0.0.0.0 BROWSER_PORT=4311 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium && chmod -R a+rX /ms-playwright
COPY --from=build /app/dist/server ./dist/server
USER node
EXPOSE 4311
CMD ["node", "dist/server/browser/index.js"]
