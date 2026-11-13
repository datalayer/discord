import { SolrClient } from "../../src/solr/client.js";
import { SolrRecords } from "../../src/solr/records.js";

/**
 * A throwaway Solr collection of one test file's own, made again from the
 * platform's configset, for the tests that run against a real SolrCloud:
 * opt-in with `DATALAYER_SOLR_TEST_URL` (`http://localhost:8983/solr`), the
 * configset already uploaded under `DATALAYER_SOLR_TEST_CONFIGSET` (the
 * platform's `datalayer-solr` config), and `DATALAYER_SOLR_TEST_USERNAME` /
 * `DATALAYER_SOLR_TEST_PASSWORD` when the cluster asks for them.
 */
export const solrTestUrl = process.env.DATALAYER_SOLR_TEST_URL;

export async function testCollection(name: string): Promise<SolrRecords> {
  const url = required(solrTestUrl, "DATALAYER_SOLR_TEST_URL");
  const configset = required(
    process.env.DATALAYER_SOLR_TEST_CONFIGSET,
    "DATALAYER_SOLR_TEST_CONFIGSET",
  );
  const username = process.env.DATALAYER_SOLR_TEST_USERNAME ?? "solr";
  const password = process.env.DATALAYER_SOLR_TEST_PASSWORD ?? "";
  const headers = {
    authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  };
  const admin = async (params: Record<string, string>): Promise<Response> =>
    fetch(
      `${url}/admin/collections?${new URLSearchParams(params).toString()}`,
      {
        headers,
      },
    );
  await admin({ action: "DELETE", name });
  const created = await admin({
    action: "CREATE",
    "collection.configName": configset,
    name,
    numShards: "2",
    replicationFactor: "1",
  });
  if (!created.ok)
    throw new Error(`Collection ${name} was not made: ${await created.text()}`);
  return new SolrRecords(
    new SolrClient({ collection: name, password, url, username }),
    { leaseMs: 5_000, stripes: 8 },
  );
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
