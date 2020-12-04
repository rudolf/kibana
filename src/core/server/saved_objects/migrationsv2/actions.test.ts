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

describe('actions', () => {
  describe('catchRetryableEsClientErrors returns left retryable_es_client_error for', () => {
    it.todo('NoLivingConnectionsError');
    it.todo('ConnectionError');
    it.todo('TimeoutError');
    it.todo('ResponseError of type snapshot_in_progress_exception');
    it.todo('ResponseError with retryable status code'); // 503,401,403,408,410
  });
});
