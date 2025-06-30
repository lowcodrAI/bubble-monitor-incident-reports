// Enhanced Supabase Edge Function – Bubble Monitor v4.1.1 - FIXED
// 
// BUG FIX: Removed invalid session_id field that was causing sample creation failures
// Issue: PostgreSQL was rejecting INSERTs due to non-existent column reference
// Solution: Store session_id in metadata JSON field instead
//
// Related: incidents/2025-06-30-log-samples-outage.md

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const N8N_WEBHOOK_URL = Deno.env.get("N8N_WEBHOOK_ENRICH_URL");
const N8N_KEY = Deno.env.get("N8N_WEBHOOK_KEY") ?? "";

function toHex(buf) {
  return Array.from(new Uint8Array(buf)).map((b)=>b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for(let i = 0; i < a.length; i++)diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Generate session ID if not provided
function generateSessionId() {
  return 'sess_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

Deno.serve(async (req)=>{
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-BM-Key, X-BM-Signature, X-N8N-Key"
  };
  
  if (req.method === "OPTIONS") return new Response(null, {
    status: 204,
    headers: corsHeaders
  });
  
  const key = req.headers.get("x-bm-key");
  const signature = req.headers.get("x-bm-signature");
  
  if (!key || !signature) return new Response("Missing headers", {
    status: 401,
    headers: corsHeaders
  });
  
  const rawBody = new Uint8Array(await req.arrayBuffer());
  
  // Get app data
  const appRes = await fetch(`${supabaseUrl}/rest/v1/apps?public_key=eq.${key}`, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`
    }
  });
  
  const apps = await appRes.json();
  if (!apps.length) return new Response("Invalid app key", {
    status: 401,
    headers: corsHeaders
  });
  
  const app = apps[0];
  
  // Verify signature
  const hmacKey = await crypto.subtle.importKey("raw", encoder.encode(app.secret), {
    name: "HMAC",
    hash: "SHA-256"
  }, false, [
    "sign"
  ]);
  
  const signed = await crypto.subtle.sign("HMAC", hmacKey, rawBody);
  const expected = toHex(signed);
  
  if (!timingSafeEqual(expected, signature)) return new Response("Bad signature", {
    status: 401,
    headers: corsHeaders
  });
  
  // Parse payload
  const { version = 1, payloads = [] } = JSON.parse(decoder.decode(rawBody));
  
  if (!Array.isArray(payloads) || payloads.length === 0 || payloads.length > 50) {
    return new Response("Invalid payload", {
      status: 400,
      headers: corsHeaders
    });
  }
  
  const now = new Date();
  const nowIso = now.toISOString();
  const today = nowIso.slice(0, 10);
  
  const headers = {
    "Content-Type": "application/json",
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`
  };
  
  // Process each payload
  for (const p of payloads){
    const isEnhanced = version >= 2 && p.enhanced_version >= 2;
    
    // Extract basic fields (compatible with v1)
    const { 
      fp, 
      code, 
      msg, 
      level, 
      count = 1, 
      priority = null, 
      user_id, 
      session_id = null, 
      metadata, 
      bubble, 
      page_name = null, 
      event_path = null, 
      element_name = null, 
      workflow_id = null, 
      element_bubble_id = null, 
      source = "frontend" 
    } = p;
    
    // Extract enhanced fields (v2+)
    const { 
      browser_state = null, 
      memory_usage = null, 
      network_info = null, 
      performance_info = null, 
      breadcrumbs = [] 
    } = p;
    
    const environment = metadata?.environment || "unknown";
    const fingerprint = fp;
    
    // Use session_id from payload or generate one
    const effectiveSessionId = session_id || generateSessionId();
    
    // Find or create log group
    const findRes = await fetch(`${supabaseUrl}/rest/v1/monitor_log_groups?select=id,count&app_id=eq.${app.id}&fingerprint=eq.${fingerprint}`, {
      headers
    });
    
    const existing = await findRes.json();
    let group_id;
    let isNewGroup = false;
    
    if (existing.length) {
      const current = existing[0];
      group_id = current.id;
      
      // Update existing group
      await fetch(`${supabaseUrl}/rest/v1/monitor_log_groups?id=eq.${group_id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          count: current.count + count,
          last_seen: nowIso
        })
      });
    } else {
      // Create new group
      const insRes = await fetch(`${supabaseUrl}/rest/v1/monitor_log_groups`, {
        method: "POST",
        headers: {
          ...headers,
          Prefer: "return=representation"
        },
        body: JSON.stringify([
          {
            app_id: app.id,
            fingerprint,
            code,
            message: msg,
            log_level: level,
            priority,
            first_seen: nowIso,
            last_seen: nowIso,
            count,
            source,
            page_name,
            workflow_id,
            element_bubble_id,
            event_path,
            environment,
            affected_user_count: 0
          }
        ])
      });
      
      const newRow = await (async ()=>{
        try {
          return await insRes.json();
        } catch  {
          return [{}];
        }
      })();
      
      group_id = newRow[0]?.id;
      isNewGroup = true;
      
      // Trigger enrichment webhook for new groups
      if (group_id) {
        fetch(N8N_WEBHOOK_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-N8N-Key": N8N_KEY
          },
          body: JSON.stringify({
            group_id,
            enhanced: isEnhanced
          })
        }).then(async (res)=>{
          console.log("n8n webhook status:", res.status, await res.text());
        }).catch((err)=>{
          console.error("Enrichment trigger failed:", err);
        });
      } else {
        console.warn("group_id undefined after insert – skipping webhook trigger");
      }
    }
    
    // Track unique sessions per group (only if we have a session)
    if (group_id && effectiveSessionId) {
      try {
        // Try to insert session tracking (will be ignored if already exists due to UNIQUE constraint)
        const sessionTrackRes = await fetch(`${supabaseUrl}/rest/v1/monitor_group_sessions`, {
          method: "POST",
          headers: {
            ...headers,
            Prefer: "resolution=ignore-duplicates"
          },
          body: JSON.stringify([
            {
              group_id,
              session_id: effectiveSessionId,
              first_seen: nowIso
            }
          ])
        });
        
        // Update affected user count for the group
        const countRes = await fetch(`${supabaseUrl}/rest/v1/monitor_group_sessions?select=*&group_id=eq.${group_id}`, {
          headers: {
            ...headers,
            Prefer: "count=exact"
          }
        });
        
        const userCount = parseInt(countRes.headers.get('content-range')?.split('/')[1] || '0');
        
        await fetch(`${supabaseUrl}/rest/v1/monitor_log_groups?id=eq.${group_id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            affected_user_count: userCount
          })
        });
        
        console.log(`Session tracking: group_id=${group_id}, session_id=${effectiveSessionId}, total_users=${userCount}`);
      } catch (error) {
        console.error("Session tracking failed:", error);
        // Continue processing even if session tracking fails
      }
    }
    
    // Update group stats
    await fetch(`${supabaseUrl}/rest/v1/monitor_log_group_stats?on_conflict=group_id,date`, {
      method: "POST",
      headers,
      body: JSON.stringify([
        {
          group_id,
          date: today,
          count
        }
      ])
    });
    
    // Create log sample if user_id exists
    if (user_id) {
      const sampleRes = await fetch(`${supabaseUrl}/rest/v1/monitor_log_samples?select=id&group_id=eq.${group_id}&user_id=eq.${user_id}`, {
        headers
      });
      
      const already = await sampleRes.json();
      
      // Create sample (either first time or 10% sampling for existing users)
      if (!already.length || Math.random() < 0.1) {
        // FIXED: Removed invalid session_id field and store it in metadata instead
        const sampleData = {
          group_id,
          user_id,
          // REMOVED: session_id: effectiveSessionId, // This column doesn't exist!
          metadata: {
            ...(metadata || {}),
            session_id: effectiveSessionId // Store session_id in metadata
          },
          bubble: bubble || {},
          created_at: nowIso,
          page_name,
          workflow_id,
          element_bubble_id,
          event_path,
          element_name,
          environment,
          is_enhanced: isEnhanced,
          breadcrumbs_count: breadcrumbs.length
        };
        
        const sampleInsertRes = await fetch(`${supabaseUrl}/rest/v1/monitor_log_samples`, {
          method: "POST",
          headers: {
            ...headers,
            Prefer: "return=representation"
          },
          body: JSON.stringify([sampleData])
        });
        
        // ENHANCED ERROR HANDLING: Better logging for debugging
        const responseText = await sampleInsertRes.text();
        let sampleResult;
        
        try {
          sampleResult = JSON.parse(responseText);
        } catch (parseError) {
          console.error("Sample insert failed - Invalid JSON response:", responseText);
          console.error("Sample data attempted:", JSON.stringify(sampleData, null, 2));
          continue; // Skip to next payload
        }
        
        // Check HTTP status
        if (!sampleInsertRes.ok) {
          console.error(`Sample insert failed - HTTP ${sampleInsertRes.status}:`, responseText);
          console.error("Sample data attempted:", JSON.stringify(sampleData, null, 2));
          continue; // Skip to next payload
        }
        
        const sample_id = sampleResult[0]?.id;
        
        if (!sample_id) {
          console.error("Sample insert succeeded but no ID returned:", sampleResult);
          continue;
        }
        
        console.log(`Sample created successfully: ${sample_id} for group: ${group_id}`);
        
        // If enhanced error, store additional context
        if (isEnhanced && sample_id) {
          // Store enhanced context
          if (browser_state || memory_usage || network_info || performance_info) {
            await fetch(`${supabaseUrl}/rest/v1/monitor_error_context`, {
              method: "POST",
              headers,
              body: JSON.stringify([
                {
                  sample_id,
                  browser_state,
                  memory_usage,
                  network_info,
                  performance_info,
                  bubble_context: bubble,
                  enhanced_version: p.enhanced_version || 2
                }
              ])
            });
          }
          
          // Store breadcrumbs
          if (breadcrumbs.length > 0) {
            const breadcrumbsData = breadcrumbs.map((breadcrumb)=>({
                sample_id,
                breadcrumb_type: breadcrumb.type,
                breadcrumb_level: breadcrumb.level || 'info',
                breadcrumb_data: breadcrumb.data,
                timestamp_ms: breadcrumb.timestamp
              }));
            
            // Insert breadcrumbs in batches if there are many
            const batchSize = 10;
            for(let i = 0; i < breadcrumbsData.length; i += batchSize){
              const batch = breadcrumbsData.slice(i, i + batchSize);
              await fetch(`${supabaseUrl}/rest/v1/monitor_error_breadcrumbs`, {
                method: "POST",
                headers,
                body: JSON.stringify(batch)
              });
            }
          }
          
          console.log(`Enhanced error processed: ${breadcrumbs.length} breadcrumbs, sample_id: ${sample_id}`);
        }
      }
    }
  }
  
  return new Response("OK", {
    status: 200,
    headers: corsHeaders
  });
});
