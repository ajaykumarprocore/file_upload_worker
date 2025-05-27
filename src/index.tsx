import { ExportedHandler, R2Bucket, R2UploadedPart, Request, ExecutionContext } from '@cloudflare/workers-types';

/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
interface Env {
	MY_BUCKET: R2Bucket;
}

// Helper function to add CORS headers to a response
function addCorsHeaders(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set('Access-Control-Allow-Origin', '*');
	headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
	headers.set('Access-Control-Allow-Headers', 'Content-Type, Procore-Fas-User-Id');
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Handle preflight requests
		if (request.method === 'OPTIONS') {
			return addCorsHeaders(new Response(null, {
				status: 204,
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Procore-Fas-User-Id',
					'Access-Control-Max-Age': '86400'
				}
			}));
		}

		const bucket = env.MY_BUCKET;
		const url = new URL(request.url);
		const key = url.pathname.slice(1);
		const action = url.searchParams.get("action");
		console.log("action", action);
		console.log("key", key);
		if (action === null) {
			return addCorsHeaders(new Response("Missing action type", { status: 400 }));
		}
		
		// Route the request based on the HTTP method and action type
		switch (request.method) {
			case "POST":
				switch (action) {
					case "mpu-create": {
						const multipartUpload = await bucket.createMultipartUpload(key);
						return addCorsHeaders(new Response(
							JSON.stringify({
								key: multipartUpload.key,
								uploadId: multipartUpload.uploadId,
							})
						));
					}
					case "mpu-complete": {
						const uploadId = url.searchParams.get("uploadId");
						if (uploadId === null) {
							return addCorsHeaders(new Response("Missing uploadId", { status: 400 }));
						}

						const multipartUpload = env.MY_BUCKET.resumeMultipartUpload(
							key,
							uploadId
						);

						interface completeBody {
							parts: R2UploadedPart[];
						}
						const completeBody: completeBody = await request.json();
						if (completeBody === null) {
							return addCorsHeaders(new Response("Missing or incomplete body", {
								status: 400,
							}));
						}

						// Error handling in case the multipart upload does not exist anymore
						try {
							const object = await multipartUpload.complete(completeBody.parts);
							return addCorsHeaders(new Response(null, {
								headers: {
									etag: object.httpEtag,
								},
							}));
						} catch (error: any) {
							return addCorsHeaders(new Response(error.message, { status: 400 }));
						}
					}
					default:
						return addCorsHeaders(new Response(`Unknown action ${action} for POST`, {
							status: 400,
						}));
				}
			case "PUT":
				switch (action) {
					case "s3-put": {
						const uploadId = url.searchParams.get("uploadId");
						const partNumberString = url.searchParams.get("partNumber");
						if (partNumberString === null || uploadId === null) {
							return addCorsHeaders(new Response("Missing partNumber or uploadId", {
								status: 400,
							}));
						}
						console.log("uploadId", uploadId);
						console.log("partNumberString", partNumberString);
						if (request.body === null) {
							return addCorsHeaders(new Response("Missing request body", { status: 400 }));
						}

						// Make GET request to the specified endpoint
						const getUrl = `http://localhost:7000/rest/v2.0/companies/8/projects/8/uploads/${uploadId}/parts/${partNumberString}`;
						console.log("Making GET request to:", getUrl);
						const getResponse = await fetch(getUrl, {
							headers: {
								'Procore-Fas-User-Id': '789'
							}
						});
						
						if (!getResponse.ok) {
							console.error("GET request failed:", getResponse.status, getResponse.statusText);
							return addCorsHeaders(new Response(`Failed to fetch part: ${getResponse.statusText}`, { status: getResponse.status }));
						}

						const partData = await getResponse.json();
						console.log("GET Response:", {
							status: getResponse.status,
							headers: Object.fromEntries(getResponse.headers.entries()),
							data: partData
						});

						// Extract the required fields from the response
						const { id, url: partUrl, headers: partHeaders } = partData;
						console.log("Part details:", {
							id,
							url: partUrl,
							headers: partHeaders
						});

						// Make PUT request to partUrl with partHeaders
						console.log("Making PUT request to:", partUrl);
						const putResponse = await fetch(partUrl, {
							method: 'PUT',
							headers: {
								...partHeaders,
								'Procore-Fas-User-Id': '789'
							},
							body: await request.arrayBuffer()
						});

						if (!putResponse.ok) {
							console.error("PUT request failed:", putResponse.status, putResponse.statusText);
							return addCorsHeaders(new Response(`Failed to upload part: ${putResponse.statusText}`, { status: putResponse.status }));
						}

						console.log("PUT Response:", {
							status: putResponse.status,
							headers: Object.fromEntries(putResponse.headers.entries())
						});

						// Get ETag from response headers
						const etag = putResponse.headers.get('etag');
						console.log("ETag from PUT response:", etag);

						// Make PATCH request to update segments
						const patchUrl = `http://localhost:7000/rest/v2.0/companies/8/projects/8/uploads/${uploadId}`;
						console.log("Making PATCH request to:", patchUrl);

						console.log("Body:", JSON.stringify({
							segments: [{
								etag: etag,
								part_number: parseInt(partNumberString)
							}]
						}));
						const patchResponse = await fetch(patchUrl, {
							method: 'PATCH',
							headers: {
								'Content-Type': 'application/json',
								'Procore-Fas-User-Id': '789'
							},
							body: JSON.stringify({
								segments: [{
									etag: etag,
									part_number: parseInt(partNumberString)
								}]
							})
						});

						if (!patchResponse.ok) {
							console.error("PATCH request failed:", patchResponse.status, patchResponse.statusText);
							return addCorsHeaders(new Response(`Failed to update segments: ${patchResponse.statusText}`, { status: patchResponse.status }));
						}

						console.log("PATCH Response:", {
							status: patchResponse.status,
							headers: Object.fromEntries(patchResponse.headers.entries())
						});

						// Return success response with ETag
						return addCorsHeaders(new Response(JSON.stringify({
							id,
							partNumber: parseInt(partNumberString),
							status: 'success',
							etag: etag
						})));
					}
					case "mpu-uploadpart": {
						const uploadId = url.searchParams.get("uploadId");
						const partNumberString = url.searchParams.get("partNumber");
						if (partNumberString === null || uploadId === null) {
							return addCorsHeaders(new Response("Missing partNumber or uploadId", {
								status: 400,
							}));
						}
						if (request.body === null) {
							return addCorsHeaders(new Response("Missing request body", { status: 400 }));
						}

						const partNumber = parseInt(partNumberString);
						const multipartUpload = env.MY_BUCKET.resumeMultipartUpload(
							key,
							uploadId
						);
						try {
							const uploadedPart: R2UploadedPart =
								await multipartUpload.uploadPart(partNumber, request.body);
							return addCorsHeaders(new Response(JSON.stringify(uploadedPart)));
						} catch (error: any) {
							return addCorsHeaders(new Response(error.message, { status: 400 }));
						}
					}
					default:
						return addCorsHeaders(new Response(`Unknown action ${action} for PUT`, {
							status: 400,
						}));
				}
			case "GET":
				if (action !== "get") {
					return addCorsHeaders(new Response(`Unknown action ${action} for GET`, {
						status: 400,
					}));
				}
				const object = await env.MY_BUCKET.get(key);
				if (object === null) {
					return addCorsHeaders(new Response("Object Not Found", { status: 404 }));
				}
				const headers = new Headers();
				object.writeHttpMetadata(headers);
				headers.set("etag", object.httpEtag);
				return addCorsHeaders(new Response(object.body, { headers }));
			case "DELETE":
				switch (action) {
					case "mpu-abort": {
						const uploadId = url.searchParams.get("uploadId");
						if (uploadId === null) {
							return addCorsHeaders(new Response("Missing uploadId", { status: 400 }));
						}
						const multipartUpload = env.MY_BUCKET.resumeMultipartUpload(
							key,
							uploadId
						);

						try {
							multipartUpload.abort();
						} catch (error: any) {
							return addCorsHeaders(new Response(error.message, { status: 400 }));
						}
						return addCorsHeaders(new Response(null, { status: 204 }));
					}
					case "delete": {
						await env.MY_BUCKET.delete(key);
						return addCorsHeaders(new Response(null, { status: 204 }));
					}
					default:
						return addCorsHeaders(new Response(`Unknown action ${action} for DELETE`, {
							status: 400,
						}));
				}
			default:
				return addCorsHeaders(new Response("Method Not Allowed", {
					status: 405,
					headers: { Allow: "PUT, POST, GET, DELETE" },
				}));
		}
	},
} satisfies ExportedHandler<Env>;