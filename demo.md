# A2A Stream Demo

## Background

In ../kube-agents-vamp/ we have been working on a security revamp for kube-agents (found in ../kube-agents-vamp/kube-agents/)

This is only for context though because we have also started a next-gen architecture plan in ../kube-agents=vamp/round_2/ - I want to focus on a small piece of that for a demo.

## The problem

Today kube-agents uses the hermes agent harness, and in particular its internal kanban task management flow.  This winds up where a central "chat agent" delegates tasks to other agent sessions via kanban "cards".  The issue that my manager is really cheesed off about is that unlike a normal hermes session where the interactive chat session maintains context about the conversation, this results in a situation where the chat agent is totally clueless about what the other agents are doing, status, etc.

## What this has to do with the new architecture

I have proposed something not all that dissimilar in round_2, where we have a distinct "ChatOps" agent whose sole job is to talk to users, delegate tasks to agents in other pods, nodes, or clusters, and relay their status back.  I have proposed using the A2A protocol but substituting its default transport (HTTPS) with NATS Jetstream instead.  Many more details available in round_2/.

I have found that the people who sponsor NATS already have a pretty solid-looking A2A-over-NATS definition:

* https://nats.io/blog/nats-native-protocol-for-ai-agents/
* https://github.com/synadia-ai/synadia-agent-sdk-docs
* https://github.com/synadia-ai/synadia-agent-sdk-docs/blob/main/core-protocol.md

This defines and supports a way to delegate tasks to an agent, subscribe to results from those tasks, and stream those result chunks back to the subscribers (typically the delegator).

## Demo Goal

I want to build a demo to show how this can work before we go all the way down the road of revamping the whole architecture.  The basic idea:

1. The cluster testbed will be a Kubernetes (k8s) cluster in GKE.
2. Install NATS server in this cluster.
3. Define a k8s manifest that creates a "ChatOps" pod that runs a Claude Code instance that has been taught to use this A2A protocol and has NATS client access, registers with the bus.
4. This agent has access to the k8s api server with sufficient permissions to create new pods in its own namespace.
5. Create and expose a nice-looking web interface that lets you chat with the Claude-code instance, and shows a graphical representation of this main pod.
6. Telling this claude code instance to do something that involves a task that is more than just a single LLM turn will spawn a new pod (and a named "session" to go with it) that contains another instance of claude code, which also attaches to the NATS bus and understands the A2A protocol.  This delegate worker pod may have a different (but similar) manifest if necessary.
7. This instance receives the A2A task definition over the NATS bus.  The originating agent subscribes to the results stream, and the delegate publishes its thinking, responses, results, whatever we have - to that subscription endpoint.
8. The web interface shows the new pod has been created, and a connection exists between the two, and pulsates or transmits packets whenever a chunk is sent over the wire.
9. The originating chatops pod displays the content from the delegate pod in the chat window, prefixed with the appropriate session name.
10. When the delegated task is finished, the pod exits, the web interface reflects that it is done (greys out, then disappears perhaps?)
11. The main chat pod updates the chat with the final result.

### Particulars 

* We can spin up as many pods as we want (within reason) by continuing to ask the chatops pod for more work.  It spawns new pods and interleaves the results in chat with the appropriate prefixes.
* While the tasks are executing we can query the status of those tasks by asking the main chatops pod about the session's progress or other details, and it *interrogates the session results* that it has received and summarizes what's happening.
* My corporate Claude access is provided via a Vertex AI deployment, we'll need to sort out how to make a k8s pod be able to use that.  It is possible, because our GitHub review bots use it.  Failing that, we can fall back to my personal API keys, or switch the agents to use Gemini/Antigravity instead.

### Purpose

Demonstrate two major things:

- with A2A + NATS we can spin up ephemeral agents, delegate tasks to them, and stream the results in realtime back to the user (optionally)
- The originating chat agent can inspect those results and understand the context of the executing tasks

