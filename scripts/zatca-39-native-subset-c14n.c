#include <libxml/c14n.h>
#include <libxml/parser.h>
#include <libxml/xpath.h>
#include <libxml/xpathInternals.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int write_all(const char *path, const xmlChar *bytes, int length) {
  FILE *output = fopen(path, "wb");
  if (output == NULL) {
    perror("fopen");
    return 1;
  }
  const size_t expected = (size_t)length;
  const size_t written = fwrite(bytes, 1, expected, output);
  if (written != expected) {
    perror("fwrite");
    fclose(output);
    return 1;
  }
  if (fclose(output) != 0) {
    perror("fclose");
    return 1;
  }
  return 0;
}

static int register_namespaces(xmlXPathContextPtr context) {
  const struct {
    const char *prefix;
    const char *uri;
  } namespaces[] = {
      {"ext", "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"},
      {"cac", "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"},
      {"cbc", "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"},
      {"ds", "http://www.w3.org/2000/09/xmldsig#"},
      {"xades", "http://uri.etsi.org/01903/v1.3.2#"},
  };
  const size_t count = sizeof(namespaces) / sizeof(namespaces[0]);
  for (size_t index = 0; index < count; index += 1) {
    if (xmlXPathRegisterNs(context, BAD_CAST namespaces[index].prefix,
                           BAD_CAST namespaces[index].uri) != 0) {
      fprintf(stderr, "failed to register XPath namespace %s\n",
              namespaces[index].prefix);
      return 1;
    }
  }
  return 0;
}

static xmlXPathObjectPtr evaluate(xmlXPathContextPtr context,
                                  const char *expression) {
  xmlXPathObjectPtr result =
      xmlXPathEvalExpression(BAD_CAST expression, context);
  if (result == NULL || result->type != XPATH_NODESET ||
      result->nodesetval == NULL) {
    fprintf(stderr, "native XPath evaluation failed: %s\n", expression);
    if (result != NULL) {
      xmlXPathFreeObject(result);
    }
    return NULL;
  }
  return result;
}

int main(int argc, char **argv) {
  if (argc != 4) {
    fprintf(stderr,
            "usage: %s <invoice.xml> <invoice|signed-info|signed-properties> "
            "<output.c14n.xml>\n",
            argv[0]);
    return 64;
  }

  const char *target = argv[2];
  const char *target_expression = NULL;
  const char *nodes_expression = NULL;
  if (strcmp(target, "invoice") == 0) {
    nodes_expression =
        "(//node() | //@* | //namespace::*)[not(ancestor-or-self::ext:UBLExtensions) "
        "and not(ancestor-or-self::cac:Signature) and "
        "not(ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])]";
  } else if (strcmp(target, "signed-info") == 0) {
    target_expression = "//ds:SignedInfo";
    nodes_expression =
        "//ds:SignedInfo/descendant-or-self::node() | "
        "//ds:SignedInfo/descendant-or-self::*/@* | "
        "//ds:SignedInfo/descendant-or-self::*/namespace::*";
  } else if (strcmp(target, "signed-properties") == 0) {
    target_expression = "//xades:SignedProperties[@Id='xadesSignedProperties']";
    nodes_expression =
        "//xades:SignedProperties[@Id='xadesSignedProperties']/descendant-or-self::node() | "
        "//xades:SignedProperties[@Id='xadesSignedProperties']/descendant-or-self::*/@* | "
        "//xades:SignedProperties[@Id='xadesSignedProperties']/descendant-or-self::*/namespace::*";
  } else {
    fprintf(stderr, "unsupported native C14N target: %s\n", target);
    return 64;
  }

  xmlInitParser();
  xmlDocPtr document = xmlReadFile(
      argv[1], NULL,
      XML_PARSE_NONET | XML_PARSE_NOERROR | XML_PARSE_NOWARNING | XML_PARSE_NOBLANKS);
  if (document == NULL) {
    fprintf(stderr, "native libxml2 failed to parse sealed invoice\n");
    xmlCleanupParser();
    return 65;
  }
  if (document->intSubset != NULL || document->extSubset != NULL) {
    fprintf(stderr, "native C14N oracle refuses DTD-bearing XML\n");
    xmlFreeDoc(document);
    xmlCleanupParser();
    return 65;
  }

  xmlXPathContextPtr context = xmlXPathNewContext(document);
  if (context == NULL || register_namespaces(context) != 0) {
    if (context != NULL) {
      xmlXPathFreeContext(context);
    }
    xmlFreeDoc(document);
    xmlCleanupParser();
    return 66;
  }

  if (target_expression != NULL) {
    xmlXPathObjectPtr target_nodes = evaluate(context, target_expression);
    if (target_nodes == NULL || target_nodes->nodesetval->nodeNr != 1) {
      fprintf(stderr, "native C14N oracle requires exactly one %s target\n",
              target);
      if (target_nodes != NULL) {
        xmlXPathFreeObject(target_nodes);
      }
      xmlXPathFreeContext(context);
      xmlFreeDoc(document);
      xmlCleanupParser();
      return 67;
    }
    xmlXPathFreeObject(target_nodes);
  }

  xmlXPathObjectPtr nodes = evaluate(context, nodes_expression);
  if (nodes == NULL || nodes->nodesetval->nodeNr == 0) {
    fprintf(stderr, "native C14N oracle selected no nodes for %s\n", target);
    if (nodes != NULL) {
      xmlXPathFreeObject(nodes);
    }
    xmlXPathFreeContext(context);
    xmlFreeDoc(document);
    xmlCleanupParser();
    return 68;
  }

  xmlChar *canonical = NULL;
  const int length = xmlC14NDocDumpMemory(
      document, nodes->nodesetval, XML_C14N_1_1, NULL, 0, &canonical);
  if (length < 0 || canonical == NULL) {
    fprintf(stderr, "native libxml2 Canonical XML 1.1 failed for %s\n", target);
    xmlXPathFreeObject(nodes);
    xmlXPathFreeContext(context);
    xmlFreeDoc(document);
    xmlCleanupParser();
    return 69;
  }

  const int result = write_all(argv[3], canonical, length);
  xmlFree(canonical);
  xmlXPathFreeObject(nodes);
  xmlXPathFreeContext(context);
  xmlFreeDoc(document);
  xmlCleanupParser();
  return result;
}
