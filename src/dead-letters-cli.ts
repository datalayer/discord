import { Logger } from "@datalayer/agent-runtimes/lib/portable/hosts";

import { readConfig } from "./config.js";
import { LOG_SALT } from "./observability.js";
import { solrSettingsOf } from "./resources.js";
import { SolrClient } from "./solr/client.js";
import { runDeadLettersCli, SolrDeadLetters } from "./solr/dead-letters.js";
import { SolrWorkQueue } from "./solr/queue.js";
import { SolrRecords } from "./solr/records.js";

/**
 * `node dist/dead-letters.js list | replay <id> | payload <id> <reason…>`
 * against the service's Solr collection, as DATALAYER_OPERATOR (DC-403): a
 * job's id is its uid. Reads the service's own settings
 * (`DATALAYER_SOLR_URL` and its credentials required); every replay and
 * payload read is kept in the collection and audited in the logs.
 */
const config = readConfig();
const records = new SolrRecords(new SolrClient(solrSettingsOf(config)));
process.exitCode = await runDeadLettersCli(
  new SolrDeadLetters(
    new SolrWorkQueue<unknown>(records),
    "discord",
    new Logger(undefined, undefined, LOG_SALT),
  ),
  process.argv.slice(2),
  process.env.DATALAYER_OPERATOR?.trim() ?? "",
);
