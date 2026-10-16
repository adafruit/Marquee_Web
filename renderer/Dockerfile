# The renderer as an AWS Lambda container image.
#
# Build from the REPO ROOT, not from renderer/: the renderer imports the editor's own
# public/js/lib and public/fonts by relative path, and the image keeps that layout.
#
#   docker build -f renderer/Dockerfile -t marquee-renderer .
#
# The handler is renderer/lambda.handler. Build for the function's architecture
# (--platform linux/amd64 or linux/arm64): skia-canvas installs a native binary for the
# platform it is installed on.
FROM public.ecr.aws/lambda/nodejs:22

WORKDIR ${LAMBDA_TASK_ROOT}

COPY renderer/package.json renderer/package-lock.json renderer/
RUN cd renderer && npm ci --omit=dev && npm cache clean --force

COPY public/js/package.json public/js/
COPY public/js/lib public/js/lib
COPY public/fonts public/fonts
COPY renderer/*.js renderer/

CMD ["renderer/lambda.handler"]
