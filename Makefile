.PHONY: check image push

# The image's tag: bump it for every push, never overwrite a pushed tag.
# 0.1.0: pushed 16 October 2026 (sha256:b340ed19b34a…), pinned in up.sh datalayer_discord.
# 0.1.1: the gateway role, mentions, Post in thread, questions, quiet or noisy, Start over (Node 22).
# 0.1.1: pushed 16 October 2026 (sha256:31c30a639375…), reupped on r1.
# 0.1.2: the gateway session kept for the next leader (resumed through a rollout).
# 0.1.2: pushed 16 October 2026 (sha256:14c07607309…), reupped on r1.
# 0.1.3: direct messages (DC-203).
# 0.1.4: an answered question shows the choice (DC-304), the database roles
#        (DC-403, migration 008; off until DATALAYER_DISCORD_DATABASE_ROLES),
#        the settings check without an install link (DC-007).
# 0.1.4: pushed 19 October 2026 (sha256:a837099fa946…), reupped on r1.
# 0.1.5: the first /ask after linking on the web answered in public with its
#        thread (DC-104, migration 009: a pending link code makes the ingress
#        ask Datalayer).
# 0.1.6: a Discord application the person brings (decided 28 October 2026): POST /discord/apps/install from the
#        Ship card (application id, public key, bot token, the server among the bot's guilds; the commands
#        registered on it; bound at Datalayer as a custom installation), its interactions at
#        /discord/interactions/<application_id> verified with its own key, posted as its own bot, heard on
#        its own gateway connection (migration 010, discord_custom_app; commands/ shipped in the image).
VERSION ?= 0.1.6
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
