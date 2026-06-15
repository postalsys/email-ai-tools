# Security Policy

`@postalsys/email-ai-tools` is a Node.js library that processes email content and
forwards it to OpenAI-compatible AI APIs to generate summaries, risk assessments,
embeddings, and question answers. Because it parses untrusted email data and
handles API credentials passed in by the caller, we take security reports
seriously and aim to respond quickly.

## Supported Versions

Security fixes are released only against the latest version. We do not backport
patches to older releases - upgrading to the current release line is the
supported way to receive security updates.

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

If you are on an older version, please upgrade. See the release notes at
<https://github.com/postalsys/email-ai-tools/releases> before updating.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
pull requests, or discussions.**

Report privately through one of the following channels:

1. **GitHub Security Advisories (preferred).** Open a private report at
   <https://github.com/postalsys/email-ai-tools/security/advisories/new>. This
   keeps the discussion private until a fix is published and lets us credit you.
2. **Email.** Send details to **andris@postalsys.com**. Encrypt sensitive details
   if possible.

When reporting, please include as much of the following as you can:

- The affected version(s) and environment (library version, Node.js version, OS).
- The function involved (e.g. `generateSummary`, `riskAnalysis`,
  `generateEmbeddings`, `embeddingsQuery`, `questionQuery`, `listModels`).
- A clear description of the issue and its impact (e.g. prompt injection that
  escalates privileges in a consuming application, credential or API-token
  disclosure, SSRF via a configurable API base URL, injection, information
  disclosure, denial of service through unbounded input).
- A minimal proof of concept or reproduction steps.
- Any suggested remediation, if you have one.

We are a small team, so there is no guaranteed response time - sometimes reports
are handled within hours, sometimes they take longer. Accepted issues are fixed
in a new release and coordinated through a GitHub Security Advisory, and reporters
who wish to be named are credited.

## CVEs

We track and disclose vulnerabilities through GitHub Security Advisories. We do
not request or manage CVE identifiers ourselves. If you need a CVE assigned for a
reported issue, please request one yourself - for example, through GitHub's own
CVE request flow on the published advisory, or another CNA.

## Scope

In scope: the library source in this repository - email parsing and text
extraction, prompt construction, token budgeting, and the outbound HTTP calls to
OpenAI-compatible endpoints (including handling of the caller-supplied API token
and the configurable API base URL).

Out of scope:

- Vulnerabilities in your own application code that integrates with this library.
- The behavior, content, or safety of the AI models and API providers this
  library connects to (OpenAI or any OpenAI-compatible endpoint you configure).
- Model "hallucinations" or undesirable AI output that does not stem from a code
  defect in this library.
- Misuse such as passing untrusted endpoints as the API base URL, leaking your
  own API tokens, or exposing the library's output to untrusted parties.
- Social-engineering reports and theoretical issues without a demonstrated,
  concrete impact.

Thank you for helping keep email-ai-tools and its users safe.
