# Contributing to Eclipse Ditto MCP

Thanks for your interest in this project.

## Project description

Eclipse Ditto MCP is a [Model Context Protocol](https://modelcontextprotocol.io) server for
[Eclipse Ditto](https://eclipse.dev/ditto). It gives AI agents searchable Ditto documentation
(keyword, semantic or hybrid retrieval) and policy-gated tools generated from the Ditto OpenAPI
specification. It is part of the Eclipse Ditto project.

* https://projects.eclipse.org/projects/iot.ditto
* Documentation: [README.md](README.md)

## Terms of Use

This repository is subject to the Terms of Use of the Eclipse Foundation

* https://www.eclipse.org/legal/termsofuse.php

## Developer resources

* Source code: https://github.com/eclipse-ditto/ditto-mcp
* Issues: https://github.com/eclipse-ditto/ditto-mcp/issues
* Eclipse Ditto developer resources: https://projects.eclipse.org/projects/iot.ditto/developer

### Setting up the development environment

You need Node.js 22 or newer and npm.

```shell
git clone https://github.com/eclipse-ditto/ditto-mcp.git
cd ditto-mcp
npm ci      # on Linux x64: ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci
npm run build
```

On Linux x64, `onnxruntime-node` tries to download optional CUDA binaries during installation.
Inference is CPU-only, so set `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` to skip that download.

### Checks to run before opening a pull request

```shell
npm run typecheck
npm test
npm run test:pg   # Postgres/pgvector tests, needs Docker
```

See [README.md](README.md) for configuration and for running the server locally.

## Project License

This program and the accompanying materials are made available under the terms of the
Eclipse Public License 2.0 which is available at https://www.eclipse.org/legal/epl-2.0.

SPDX-License-Identifier: EPL-2.0

Contributions are received under the terms of the project licence.

Every new file must start with the license header used in this repository:

```
Copyright (c) <year> Contributors to the Eclipse Foundation

See the NOTICE file(s) distributed with this work for additional
information regarding copyright ownership.

This program and the accompanying materials are made available under the
terms of the Eclipse Public License 2.0 which is available at
http://www.eclipse.org/legal/epl-2.0

SPDX-License-Identifier: EPL-2.0
```

`<year>` is the year the file is created.

## Making your changes

* For new features and larger changes, create a GitHub issue first so the approach can be discussed
  before much work goes into it. Small bugfixes and maintenance changes can go straight to a pull request.
* Fork the repository, create a branch, and make your changes.
* Add tests for non-trivial changes, and make sure the checks above pass.
* Open a pull request against `main`. Mark it as draft until it is ready for review.
* Before merging, a pull request needs at least one approval after a code review.

The general rules of the Eclipse Ditto project apply, see
[Ditto's contribution guide](https://github.com/eclipse-ditto/ditto/blob/master/CONTRIBUTING.md).

### Generative AI

If you use generative AI tools for a contribution, follow the
[Eclipse Foundation guidelines](https://www.eclipse.org/projects/handbook/#genai) and mark the
commits with an [`Assisted-by:` trailer](https://www.eclipse.org/projects/handbook/#genai-assisted-by),
e.g. `Assisted-by: [Provider] [Model-Family] ([Version/ID])`.

## Eclipse Foundation Development Process

This Eclipse Foundation open project is governed by the Eclipse Foundation
Development Process and operates under the terms of the Eclipse IP Policy.

* https://eclipse.org/projects/dev_process
* https://www.eclipse.org/org/documents/Eclipse_IP_Policy.pdf

## Eclipse Contributor Agreement

In order to be able to contribute to Eclipse Foundation projects you must
electronically sign the Eclipse Contributor Agreement (ECA).

* https://www.eclipse.org/legal/ECA.php

The ECA provides the Eclipse Foundation with a permanent record that you agree
that each of your contributions will comply with the commitments documented in
the Developer Certificate of Origin (DCO). Having an ECA on file associated with
the email address matching the "Author" field of your contribution's Git commits
fulfils the DCO's requirement that you sign-off on your contributions.

For more information, please see the Eclipse Committer Handbook:
https://www.eclipse.org/projects/handbook/#resources-commit

## Contact

* Chat: https://gitter.im/eclipse/ditto
* Mailing list: https://accounts.eclipse.org/mailing-list/ditto-dev
* GitHub issues: https://github.com/eclipse-ditto/ditto-mcp/issues
