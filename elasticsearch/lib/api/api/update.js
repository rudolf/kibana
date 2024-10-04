"use strict";
/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
Object.defineProperty(exports, "__esModule", { value: true });
async function UpdateApi(params, options) {
    const acceptedPath = ['id', 'index'];
    const acceptedBody = ['detect_noop', 'doc', 'doc_as_upsert', 'script', 'scripted_upsert', '_source', 'upsert'];
    const querystring = {};
    // @ts-expect-error
    const userBody = params === null || params === void 0 ? void 0 : params.body;
    let body;
    if (typeof userBody === 'string') {
        body = userBody;
    }
    else {
        body = userBody != null ? { ...userBody } : undefined;
    }
    for (const key in params) {
        if (acceptedBody.includes(key)) {
            body = body !== null && body !== void 0 ? body : {};
            // @ts-expect-error
            body[key] = params[key];
        }
        else if (acceptedPath.includes(key)) {
            continue;
        }
        else if (key !== 'body') {
            // @ts-expect-error
            querystring[key] = params[key];
        }
    }
    const method = 'POST';
    const path = `/${encodeURIComponent(params.index.toString())}/_update/${encodeURIComponent(params.id.toString())}`;
    const meta = {
        name: 'update',
        pathParts: {
            id: params.id,
            index: params.index
        }
    };
    return await this.transport.request({ path, method, querystring, body, meta }, options);
}
exports.default = UpdateApi;
//# sourceMappingURL=update.js.map