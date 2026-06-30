from page_assistant import PageAssistantClient


def main() -> None:
    import sys

    client = PageAssistantClient()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "health"
    if cmd == "health":
        import json

        print(json.dumps(client.health(), indent=2))
    elif cmd == "models":
        import json

        print(json.dumps(client.models(), indent=2))
    elif cmd == "chat":
        msg = " ".join(sys.argv[2:])
        if not msg:
            print("Usage: page-assistant chat <message>")
            raise SystemExit(1)
        result = client.chat(msg)
        import json

        print(result.get("message", json.dumps(result, indent=2)))
    else:
        print("Usage: page-assistant [health|models|chat <message>]")
