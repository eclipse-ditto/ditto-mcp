# Notices for Eclipse Ditto MCP

This content is produced and maintained by the Eclipse Ditto project.

* Project home: https://eclipse.dev/ditto
* Project page: https://projects.eclipse.org/projects/iot.ditto

# Trademarks

* Eclipse Ditto and the Eclipse Ditto project logo are trademarks of the Eclipse Foundation.
* Eclipse and the Eclipse logo are registered trademarks of The Eclipse Foundation.

# Copyright

All content is the property of the respective authors or their employers.
For more information regarding authorship of content, please consult the
listed source code repository logs.

# Declared Project Licenses

This program and the accompanying materials are made available under the terms
of the Eclipse Public License 2.0 which is available at https://www.eclipse.org/legal/epl-2.0/.

SPDX-License-Identifier: EPL-2.0

# Source Code

* https://github.com/eclipse-ditto/ditto-mcp

# Third-party Content

This project depends on the following third-party npm packages at runtime. They
are not part of the source code repository, but are installed from the npm
registry (and included in the Docker image built from this repository):

| Package                   | Version | License              |
|---------------------------|---------|----------------------|
| @huggingface/transformers | 3.8.1   | Apache-2.0           |
| @modelcontextprotocol/sdk | 1.29.0  | MIT                  |
| better-sqlite3            | 11.10.0 | MIT                  |
| express                   | 4.22.2  | MIT                  |
| pg                        | 8.22.0  | MIT                  |
| sqlite-vec                | 0.1.9   | MIT OR Apache-2.0    |
| yaml                      | 2.9.0   | ISC                  |
| zod                       | 3.25.76 | MIT                  |

These packages pull in further transitive dependencies under their own licenses;
the exact versions are pinned in `package-lock.json`.

When the semantic or hybrid retriever is configured, the embedding model
`Xenova/bge-small-en-v1.5` (an ONNX conversion of `BAAI/bge-small-en-v1.5`, MIT)
is downloaded from Hugging Face at runtime. It is not distributed with this project.

At build time, the Eclipse Ditto OpenAPI specification (EPL-2.0) is downloaded
from https://github.com/eclipse-ditto/ditto at the version pinned in
`openapi/ditto-spec.json`.

# Cryptography

Content may contain encryption software. The country in which you are currently
may have restrictions on the import, possession, and use, and/or re-export to
another country, of encryption software. BEFORE using any encryption software,
please check the country's laws, regulations and policies concerning the import,
possession, or use, and re-export of encryption software, to see if this is
permitted.
