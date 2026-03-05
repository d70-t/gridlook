import axios from "axios";

type TNercResponse = {
  results: {
    bindings: {
      Url: { value: string };
      PrefLabel: { value: string };
      Definition: { value: string };
      Deprecated: { value: "true" | "false" };
      Relation: { value: "sameAs" | "replaces" | "isReplacedBy" };
    }[];
  };
};

type TNercResults = TNercResponse["results"]["bindings"];

export type TNercVariable = {
  variable: TNercResults[0];
  replaces: TNercResults;
  replacedBy: TNercResults;
  alternatives: TNercResults;
};

const variableCache: Map<string, TNercVariable> = new Map();

function classifyBindings(
  bindings: TNercResults
): Omit<TNercVariable, "variable"> {
  const replacedByUrlSet = new Set(
    bindings
      .filter((x) => x.Relation.value === "replaces")
      .map((x) => x.Url.value)
  );
  const replacesUrlSet = new Set(
    bindings
      .filter((x) => x.Relation.value === "isReplacedBy")
      .map((x) => x.Url.value)
  );
  const first = bindings[0];
  const rest = bindings.slice(1);

  const replacedBy = rest.filter(
    (x) =>
      x.Relation.value === "replaces" ||
      (x.Relation.value === "sameAs" &&
        x.Deprecated.value === "false" &&
        first.Deprecated.value === "true" &&
        !replacedByUrlSet.has(x.Url.value))
  );
  const replaces = rest.filter(
    (x) =>
      x.Relation.value === "isReplacedBy" ||
      (x.Relation.value === "sameAs" &&
        x.Deprecated.value === "true" &&
        first.Deprecated.value === "false" &&
        !replacesUrlSet.has(x.Url.value))
  );
  const alternatives = rest.filter(
    (x) =>
      x.Relation.value === "sameAs" &&
      x.Deprecated.value === first.Deprecated.value &&
      !replacesUrlSet.has(x.Url.value) &&
      !replacedByUrlSet.has(x.Url.value)
  );
  return { replaces, replacedBy, alternatives };
}

async function fetchNercVariable(
  variableToQuery: string
): Promise<TNercVariable | null> {
  const combinedUrl = `https://vocab.nerc.ac.uk/sparql/sparql?query=PREFIX%20skos%3A%20%3Chttp%3A%2F%2Fwww.w3.org%2F2004%2F02%2Fskos%2Fcore%23%3E%0APREFIX%20owl%3A%20%3Chttp%3A%2F%2Fwww.w3.org%2F2002%2F07%2Fowl%23%3E%0APREFIX%20dc%3A%20%3Chttp%3A%2F%2Fpurl.org%2Fdc%2Felements%2F1.1%2F%3E%0APREFIX%20dcterms%3A%20%3Chttp%3A%2F%2Fpurl.org%2Fdc%2Fterms%2F%3E%0A%0ASELECT%20DISTINCT%20%28%3Ftrm%20as%20%3FUrl%29%20%28%3FtrmLab%20as%20%3FPrefLabel%29%20%28%3FtrmDef%20as%20%3FDefinition%29%20%28%3FtrmDpr%20as%20%3FDeprecated%29%20%28%3Frelation%20as%20%3FRelation%29%20WHERE%20%7B%0A%20%20%3Furl%20skos%3AexactMatch%20%3Chttp%3A%2F%2Fvocab.nerc.ac.uk%2Fstandard_name%2F${encodeURIComponent(variableToQuery)}%2F%3E%20.%0A%20%0A%20%20%7B%0A%20%20%20%20%7B%20%3Ftrm%20owl%3AsameAs%20%3Furl%20.%20BIND%28%22sameAs%22%20AS%20%3Frelation%29%20%7D%0A%20%20%20%20UNION%0A%20%20%20%20%7B%20%3Ftrm%20dcterms%3Areplaces%20%3Fx%20.%20%3Fx%20owl%3AsameAs%20%3Furl%20.%20BIND%28%22replaces%22%20AS%20%3Frelation%29%20%7D%0A%20%20%20%20UNION%0A%20%20%20%20%7B%20%3Ftrm%20dcterms%3AisReplacedBy%20%3Fx%20.%20%3Fx%20owl%3AsameAs%20%3Furl%20.%20BIND%28%22isReplacedBy%22%20AS%20%3Frelation%29%20%7D%0A%20%20%20%20UNION%0A%20%20%20%20%7B%20%3Ftrm%20owl%3AsameAs%20%3Fx%20.%20%3Fx%20owl%3AsameAs%20%3Furl%20.%20BIND%28%22sameAs%22%20AS%20%3Frelation%29%20%7D%0A%20%20%7D%0A%20%20FILTER%20REGEX%28str%28%3Ftrm%29%2C%20%22http%3A%2F%2Fvocab.nerc.ac.uk%2Fcollection%2FP07%2Fcurrent%2F%5BA-Za-z0-9%5D%2A%2F%3F%24%22%29%20.%0A%20%20%3Ftrm%20skos%3AprefLabel%20%3FtrmLab%20.%0A%20%20OPTIONAL%20%7B%20%3Ftrm%20skos%3Adefinition%20%3FtrmDef%20%7D%20.%0A%20%20OPTIONAL%20%7B%20%3Ftrm%20owl%3Adeprecated%20%3FtrmDpr%20%7D%20.%0A%7D`;
  try {
    const response = await axios.get<TNercResponse>(combinedUrl, {
      headers: { Accept: "application/sparql-results+json" },
    });
    const bindings = response.data.results.bindings;
    if (bindings.length === 0) {
      return null;
    }
    return { variable: bindings[0], ...classifyBindings(bindings) };
  } catch {
    return null;
  }
}

/**
 *  Queries the NERC vocabulary for a given variable name, and returns
 *  information about the variable, including any variables it replaces or is
 *  replaced by. The function also caches results to avoid redundant queries for the
 *  same variable.
 */
async function queryVariable(variable: string): Promise<TNercVariable | null> {
  const variableToQuery = variable.split(/[-]/, 1)[0];
  // variables with these characters are not CF-conform so don't bother querying them
  if (
    variable.includes("=") ||
    variable.includes(" ") ||
    variable.includes(">") ||
    variable.includes("<")
  ) {
    return null;
  }
  const cached = variableCache.get(variableToQuery);
  if (cached) {
    return cached;
  }
  const result = await fetchNercVariable(variableToQuery);
  if (result) {
    variableCache.set(variableToQuery, result);
  }
  return result;
}

export default queryVariable;
