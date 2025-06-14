import { ExportedHandler, R2Bucket, R2UploadedPart, Request, ExecutionContext } from '@cloudflare/workers-types';

// API URL Constants
const API_BASE_URL = 'https://staging1.procoretech-qa.com/rest/v2.0';

// API Endpoints
const UPLOAD_PART_URL = (companyId: string, projectId: string) => 
	`${API_BASE_URL}/companies/${companyId}/projects/${projectId}/file_uploads`;
const UPLOAD_PART_DETAILS_URL = (companyId: string, projectId: string, uploadId: string, partNumber: string) => 
	`${UPLOAD_PART_URL(companyId, projectId)}/${uploadId}/parts/${partNumber}`;
const UPDATE_PARTS_URL = (companyId: string, projectId: string, uploadId: string) => 
	`${UPLOAD_PART_URL(companyId, projectId)}/${uploadId}`;

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
	headers.set('Access-Control-Allow-Origin', 'https://staging1.procoretech-qa.com');
	headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
	headers.set('Access-Control-Allow-Headers', 'Content-Type, Procore-Fas-User-Id, x-csrf-token, Cookie, Procore-cookie, ETag');
	headers.set('Access-Control-Expose-Headers', 'ETag');
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
					'Access-Control-Allow-Origin': 'https://staging1.procoretech-qa.com',
					'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
					'Access-Control-Allow-Headers': 'Content-Type, Procore-Fas-User-Id, x-csrf-token, Cookie, Procore-cookie, ETag',
					'Access-Control-Expose-Headers': 'ETag',
					'Access-Control-Max-Age': '86400'
				}
			}));
		}

		const url = new URL(request.url);
		
		// Parse path segments
		const pathSegments = url.pathname.split('/').filter(segment => segment !== '');
		if (pathSegments.length < 6 || 
			pathSegments[0] !== 'companies' || 
			pathSegments[2] !== 'projects' || 
			pathSegments[4] !== 'uploads') {
			return addCorsHeaders(new Response("Invalid URL format. Expected: /companies/{id}/projects/{id}/uploads", { status: 400 }));
		}

		const companyId = pathSegments[1];
		const projectId = pathSegments[3];
		const uploadId = pathSegments[5];
		const partNumber = url.searchParams.get("partNumber");

		console.log("Company ID:", companyId);
		console.log("Project ID:", projectId);
		console.log("Upload ID:", uploadId);
		console.log("Part Number:", partNumber);

		// Route the request based on the HTTP method and action type
		switch (request.method) {
			case "PUT":
				if (partNumber === null) {
					return addCorsHeaders(new Response("Missing partNumber", {
						status: 400,
					}));
				}
				if (request.body === null) {
					return addCorsHeaders(new Response("Missing request body", { status: 400 }));
				}

				// Make GET request to the Upload URLs for the part
				const getUrl = UPLOAD_PART_DETAILS_URL(companyId, projectId, uploadId, partNumber);
				console.log("Requesting Object Storage Service Upload URL from Upload Service:", getUrl);
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
				console.log("Object Storage Service Upload URL Response:", {
					status: getResponse.status,
					headers: Object.fromEntries(getResponse.headers.entries()),
					data: partData
				});

				// Extract the required fields from the response
				const { id, url: partUrl, headers: partHeaders } = partData;
				console.log("BEGIN: Uploading contents to Permanent Storage");
				console.log("Object Storage Upload Request Details:", {
					id,
					url: partUrl,
					headers: partHeaders
				});

				// Remove Content-MD5 header if present
				const { 'Content-MD5': _, ...headersWithoutMD5 } = partHeaders;

				// Make PUT request to partUrl with partHeaders
				console.log("Uploading contents to Object Storage using PUT", partUrl);
				const putResponse = await fetch(partUrl, {
					method: 'PUT',
					headers: {
						...headersWithoutMD5,
						// Content-Length will be automatically set by the fetch API when using a stream
					},
					body: request.body as unknown as BodyInit // Cast to BodyInit to satisfy the type system
				});

				if (!putResponse.ok) {
					console.error("PUT request failed:", putResponse.status, putResponse.statusText);
					return addCorsHeaders(new Response(`Failed to upload part: ${putResponse.statusText}`, { status: putResponse.status }));
				}

				console.log("PUT Response:", {
					status: putResponse.status,
					headers: Object.fromEntries(putResponse.headers.entries())
				});

				console.log("END: Uploading contents to Permanent Storage");

				// Get ETag from response headers
				const etag = putResponse.headers.get('etag') || putResponse.headers.get('ETag');
				console.log("ETag from PUT response:", etag);

				// Make PATCH request to update segments
				const patchUrl = UPDATE_PARTS_URL(companyId, projectId, uploadId);
				console.log("Completing Uploads by making PATCH request to Upload Service:", patchUrl);

				console.log("Body:", JSON.stringify({
					segments: [{
						etag: etag,
						partId: partNumber.toString()
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
							part_id: partNumber.toString()
						}]
					})
				});

				if (!patchResponse.ok) {
					console.error("PATCH request failed:", patchResponse.status, patchResponse.statusText);
					return addCorsHeaders(new Response(`Failed to update segments: ${patchResponse.statusText}`, { status: patchResponse.status }));
				}

				const patchResponseBody = await patchResponse.json();
				console.log("PATCH Response:", {
					status: patchResponse.status,
					headers: Object.fromEntries(patchResponse.headers.entries()),
					body: patchResponseBody
				});

				// Return success response with ETag
				return addCorsHeaders(new Response(JSON.stringify({
					id,
					partNumber: parseInt(partNumber),
					status: 'success',
					etag: etag
				}))
			);
			default:
				return addCorsHeaders(new Response("Method Not Allowed", {
					status: 405,
					headers: { Allow: "PUT, POST, GET, DELETE" },
				}));
		}
	},
} satisfies ExportedHandler<Env>;