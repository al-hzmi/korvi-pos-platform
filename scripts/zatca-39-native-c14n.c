#include <libxml/c14n.h>
#include <libxml/parser.h>
#include <stdio.h>
#include <stdlib.h>

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

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: %s <input.xml> <output.c14n.xml>\n", argv[0]);
    return 64;
  }

  xmlInitParser();
  xmlDocPtr document = xmlReadFile(
      argv[1], NULL, XML_PARSE_NONET | XML_PARSE_NOERROR | XML_PARSE_NOWARNING);
  if (document == NULL) {
    fprintf(stderr, "native libxml2 failed to parse the proof fixture\n");
    xmlCleanupParser();
    return 65;
  }

  xmlChar *canonical = NULL;
  const int length = xmlC14NDocDumpMemory(
      document, NULL, XML_C14N_1_1, NULL, 0, &canonical);
  if (length < 0 || canonical == NULL) {
    fprintf(stderr, "native libxml2 Canonical XML 1.1 failed\n");
    xmlFreeDoc(document);
    xmlCleanupParser();
    return 66;
  }

  const int result = write_all(argv[2], canonical, length);
  xmlFree(canonical);
  xmlFreeDoc(document);
  xmlCleanupParser();
  return result;
}
