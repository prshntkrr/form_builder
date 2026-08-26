from rdflib import Graph, RDF, RDFS, OWL, URIRef


ONTOLOGY_FILE = "seont.owl"


def load_ontology():
    graph = Graph()
    graph.parse(ONTOLOGY_FILE, format="xml")

    print(f"Loaded {len(graph)} RDF triples")
    return graph


def find_concepts(graph, keyword):

    keyword = keyword.lower()
    results = []

    for concept in graph.subjects(RDF.type, OWL.Class):

        if not isinstance(concept, URIRef):
            continue

        label = graph.value(concept, RDFS.label)

        if label and keyword in str(label).lower():
            results.append((concept, str(label)))

    return results


def show_children(graph, concept):

    print("\nChildren / subclasses:")
    print("=" * 60)

    found = 0

    for child in graph.subjects(RDFS.subClassOf, concept):

        if not isinstance(child, URIRef):
            continue

        label = graph.value(child, RDFS.label)

        print(f"ID    : {child}")
        print(f"Label : {label}")
        print("-" * 60)

        found += 1

    print(f"Found {found} direct subclasses.")


if __name__ == "__main__":

    graph = load_ontology()

    keyword = input("\nEnter concept to search: ")

    results = find_concepts(graph, keyword)

    print("\nMatching concepts:")
    print("=" * 60)

    for i, (concept, label) in enumerate(results, 1):

        print(f"{i}. {label}")
        print(f"   {concept}")

    if not results:
        print("No concepts found.")
        exit()

    choice = int(input("\nSelect concept number: "))

    concept, label = results[choice - 1]

    print("\n==============================")
    print("SELECTED CONCEPT")
    print("==============================")

    print(f"Label: {label}")
    print(f"ID   : {concept}")

    show_children(graph, concept)