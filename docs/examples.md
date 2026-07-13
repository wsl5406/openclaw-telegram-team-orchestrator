# Examples

These examples use the default generic roles. Replace role names and aliases in your private `config/team.json`.

## Single Role

User:

```text
产品经理，你怎么看这个功能入口？
```

Expected routing:

```text
PM
```

Expected behavior:

- short product judgment
- no full PRD unless asked
- no engineer or QA summoned

## Natural Handoff

User:

```text
先让产品经理整理需求，再交给工程师实现，最后让 QA 验收。
```

Expected routing:

```text
PM -> Engineer -> QA
```

Expected behavior:

- PM writes concise requirements and acceptance criteria
- Engineer gives implementation plan or asks for approval before edits
- QA gives verification checklist/report

## Discussion Only

User:

```text
架构师和工程师讨论一下这个方案，先别写代码。
```

Expected routing:

```text
Architect -> Engineer
```

Expected behavior:

- Architect reviews risks and structure
- Engineer comments on implementation cost
- no code changes
- no full delivery document

## All Hands

User:

```text
大家都出来看一下，这个方向有没有问题？
```

Expected routing:

```text
Lead -> PM -> Architect -> Engineer -> QA
```

Expected behavior:

- each role gives a short scoped opinion
- no one silently performs local actions

## Local File Read

User:

```text
架构师，看一下 C:\workspace\demo\README.md，判断这个项目怎么接入。
```

Expected behavior:

- OpenClaw agent uses `local_files` MCP
- reads only allowed text content
- does not modify files
- asks for approval before any code/config change

## Web Research

User:

```text
产品经理，联网查一下这个赛道最近有什么案例。
```

Expected behavior:

- orchestrator provides search evidence
- agent may use `internet_research` MCP
- answer states evidence strength and uncertainty
