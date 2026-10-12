# Third-party licenses and mobile license boundary

AgentPort Mobile is licensed under **GPL-3.0-only**. This file is an engineering inventory, not legal advice; refresh it from the final lockfiles before distribution.

| Component | Intended license | Use |
|---|---|---|
| Tauri 2 | Apache-2.0 OR MIT | Mobile application runtime |
| React / React DOM | MIT | UI |
| xterm.js and addons | MIT | Terminal rendering |
| i18next / react-i18next | MIT | Localization |
| react-markdown 10.1.0 | MIT | Safe read-only Markdown preview (no raw HTML) |
| highlight.js 11.12.0 | BSD-3-Clause | Read-only code syntax highlighting |
| react-markdown transitive dependencies | MIT, except @ungap/structured-clone (ISC) | Markdown parsing and React element conversion; exact versions in package-lock.json |
| russh / russh-sftp (candidate, not yet locked) | Apache-2.0 | SSH and SFTP transport |
| Mosh (not yet vendored) | GPLv3 or later upstream | Mobile realtime terminal transport |

## File preview dependency notices

These permissive dependencies are compatible with this GPL-3.0-only mobile product. They are not linked into the desktop Rust crates. The lockfile records the exact Markdown dependency graph and its licenses; retain the upstream dependency license files when redistributing source.

### react-markdown 10.1.0 — MIT

Source: https://github.com/remarkjs/react-markdown

Copyright (c) Espen Hovlandsdal

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### highlight.js 11.12.0 — BSD 3-Clause

Source: https://github.com/highlightjs/highlight.js

Copyright (c) 2006, Ivan Sagalaev.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.
* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

### @ungap/structured-clone 1.4.0 — ISC

Copyright (c) 2021, Andrea Giammarchi, @WebReflection

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE
OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.

## Mosh boundary

Mosh code and bindings must remain inside the GPL mobile product boundary. MIT AgentPort desktop/Core/Service/Bridge/protocol crates must not link GPL Mosh code. Upstream Mosh source, modifications, notices and GPL text must accompany any distributed mobile build as required by the applicable license.
