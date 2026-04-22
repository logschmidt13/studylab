FROM denoland/deno:2.2.0

WORKDIR /app
COPY . .
RUN deno cache main.ts

EXPOSE 8080
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--unstable-kv", "main.ts"]
