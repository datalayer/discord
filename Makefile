.PHONY: check image push

# The image's tag: bump it for every push, never overwrite a pushed tag.
# 0.1.0: not pushed yet (plans/DISCORD.md DC-008, DC-501).
VERSION ?= 0.1.0
REGISTRY ?= $(DATALAYER_DOCKER_REGISTRY)
EXPORT := $(HOME)/.cache/discord-export-$(shell git rev-parse --short HEAD)

# Built from a clean export of HEAD (git archive), never the working tree.
image:
	@test -n "$(REGISTRY)" || { echo "DATALAYER_DOCKER_REGISTRY is not set." >&2; exit 1; }
	@if docker manifest inspect $(REGISTRY)/discord:$(VERSION) >/dev/null 2>&1; then \
		echo "discord:$(VERSION) is already pushed: bump VERSION." >&2; exit 1; fi
	rm -rf $(EXPORT) && mkdir -p $(EXPORT)
	git archive HEAD | tar -x -C $(EXPORT)
	docker build -t $(REGISTRY)/discord:$(VERSION) $(EXPORT)

push:
	docker push $(REGISTRY)/discord:$(VERSION)
	docker manifest inspect $(REGISTRY)/discord:$(VERSION) >/dev/null

check:
	npm run check
