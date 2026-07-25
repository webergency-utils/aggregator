FROM gcr.io/oss-fuzz-base/base-builder-javascript
COPY . $SRC/aggregator
WORKDIR $SRC/aggregator
COPY .clusterfuzzlite/build.sh $SRC/build.sh
