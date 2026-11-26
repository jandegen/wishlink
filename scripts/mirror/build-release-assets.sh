#!/bin/sh
# Builds the deployment assets of a release from a source tree.
# usage: build-release-assets.sh <src-dir> <out-dir> <version> <image-repository>
#   e.g. build-release-assets.sh . dist 1.2.3 ghcr.io/owner/wishlink
# Output: docker-compose.yml (image pinned to the version) and wishlink-<version>-k8s.tar.gz (kustomize, image pinned).
set -eu
src=$1 out=$2 version=$3 repo=$4
mkdir -p "$out"
sed "s|@IMAGE@|$repo:$version|g" "$src/docker-compose.release.yml" > "$out/docker-compose.yml"
tmp=$(mktemp -d)
cp -r "$src/k8s" "$tmp/k8s"
sed -i -e "s|^\( *newName:\).*|\1 $repo|" -e "s|^\( *newTag:\).*|\1 \"$version\"|" "$tmp/k8s/kustomization.yaml"
tar -czf "$out/wishlink-$version-k8s.tar.gz" -C "$tmp" k8s
rm -rf "$tmp"
