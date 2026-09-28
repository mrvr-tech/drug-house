import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
};

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      return new Response(
        JSON.stringify({ error: "Server misconfiguration: Supabase environment variables are missing." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 1. Verify caller authorization JWT
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Unauthorized: Missing or invalid Authorization header." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // User client to verify the caller's JWT token
    const userClient = createClient(supabaseUrl, supabaseAnonKey || supabaseServiceRoleKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false }
    });

    const { data: { user: callerUser }, error: authError } = await userClient.auth.getUser();

    if (authError || !callerUser) {
      return new Response(
        JSON.stringify({ error: "Unauthorized: Invalid or expired authentication token." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Admin client with service_role privileges
    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // 3. Verify caller's role in public.profiles (Must be 'store')
    const { data: callerProfile, error: profileError } = await adminClient
      .from("profiles")
      .select("id, role, display_name")
      .eq("id", callerUser.id)
      .single();

    if (profileError || !callerProfile || callerProfile.role !== "store") {
      return new Response(
        JSON.stringify({ error: "Forbidden: Only authorized Store Admin users can perform management actions." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse request payload
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON request body." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { action } = body;

    // =========================================================================
    // ACTION: list-users-and-labs
    // =========================================================================
    if (action === "list-users-and-labs") {
      // 1. Fetch all profiles
      const { data: profiles, error: pErr } = await adminClient
        .from("profiles")
        .select("id, role, lab_id, display_name, created_at")
        .order("created_at", { ascending: false });

      if (pErr) throw pErr;

      // 2. Fetch all labs
      const { data: labs, error: lErr } = await adminClient
        .from("labs")
        .select("*")
        .order("created_at", { ascending: true });

      if (lErr) throw lErr;

      // 3. Fetch all Auth users to resolve emails
      const { data: authData, error: aErr } = await adminClient.auth.admin.listUsers();
      if (aErr) throw aErr;

      const userEmailMap = new Map<string, string>();
      (authData.users || []).forEach(u => {
        if (u.email) userEmailMap.set(u.id, u.email);
      });

      const labMap = new Map<string, string>();
      (labs || []).forEach(l => {
        const name = l.name || l.lab_name || `Lab ${l.id}`;
        labMap.set(l.id, name);
      });

      const enrichedProfiles = (profiles || []).map(p => ({
        id: p.id,
        email: userEmailMap.get(p.id) || (p.role === "store" ? "vedantpatil230406@gmail.com" : "-"),
        display_name: p.display_name || (p.role === "store" ? "Store Keeper" : "Lab User"),
        role: p.role,
        lab_id: p.lab_id,
        lab_name: p.lab_id ? (labMap.get(p.lab_id) || "Assigned Lab") : null,
        created_at: p.created_at
      }));

      return new Response(
        JSON.stringify({
          success: true,
          users: enrichedProfiles,
          labs: labs || []
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // =========================================================================
    // ACTION: create-user
    // =========================================================================
    if (action === "create-user") {
      const { display_name, email, password, user_type, lab_id } = body;

      if (!display_name || !display_name.trim()) {
        return new Response(
          JSON.stringify({ error: "Display name is required." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (!email || !email.trim() || !email.includes("@")) {
        return new Response(
          JSON.stringify({ error: "A valid email address is required." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (!password || password.length < 6) {
        return new Response(
          JSON.stringify({ error: "Password must be at least 6 characters long." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (user_type !== "store" && user_type !== "lab") {
        return new Response(
          JSON.stringify({ error: "User type must be either 'store' or 'lab'." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      let assignedLabId: string | null = null;
      if (user_type === "lab") {
        if (!lab_id) {
          return new Response(
            JSON.stringify({ error: "Laboratory selection is required for Lab users." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Verify lab exists in public.labs
        const { data: labRecord, error: labFindErr } = await adminClient
          .from("labs")
          .select("id")
          .eq("id", lab_id)
          .single();

        if (labFindErr || !labRecord) {
          return new Response(
            JSON.stringify({ error: "The selected laboratory does not exist." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        assignedLabId = labRecord.id;
      }

      const cleanEmail = email.trim().toLowerCase();
      const cleanDisplayName = display_name.trim();

      // Create user in Supabase Auth via Admin API
      const { data: newUserData, error: createAuthErr } = await adminClient.auth.admin.createUser({
        email: cleanEmail,
        password: password,
        email_confirm: true,
        user_metadata: {
          role: user_type,
          display_name: cleanDisplayName,
          lab_id: assignedLabId
        }
      });

      if (createAuthErr || !newUserData?.user) {
        return new Response(
          JSON.stringify({ error: createAuthErr?.message || "Failed to create Supabase Auth user." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const newUserId = newUserData.user.id;

      // Upsert profile in public.profiles
      const { error: profileUpsertErr } = await adminClient
        .from("profiles")
        .upsert({
          id: newUserId,
          role: user_type,
          lab_id: assignedLabId,
          display_name: cleanDisplayName
        });

      if (profileUpsertErr) {
        // Rollback created auth user if profile insertion failed
        await adminClient.auth.admin.deleteUser(newUserId);
        throw profileUpsertErr;
      }

      return new Response(
        JSON.stringify({
          success: true,
          message: `User "${cleanDisplayName}" created successfully.`,
          user: {
            id: newUserId,
            email: cleanEmail,
            display_name: cleanDisplayName,
            role: user_type,
            lab_id: assignedLabId
          }
        }),
        { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // =========================================================================
    // ACTION: delete-user
    // =========================================================================
    if (action === "delete-user") {
      const { user_id } = body;

      if (!user_id) {
        return new Response(
          JSON.stringify({ error: "Target user ID is required." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Prevent logged-in Store/Admin from deleting themselves
      if (callerUser.id === user_id) {
        return new Response(
          JSON.stringify({ error: "Security restriction: You cannot delete your own active Store Admin account." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Check if target user exists in public.profiles
      const { data: targetProfile, error: targetProfErr } = await adminClient
        .from("profiles")
        .select("id, role, display_name")
        .eq("id", user_id)
        .single();

      if (targetProfErr || !targetProfile) {
        return new Response(
          JSON.stringify({ error: "Target user profile not found." }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Prevent deletion of any Store Admin account
      if (targetProfile.role === "store") {
        return new Response(
          JSON.stringify({ error: "Security restriction: Store Admin accounts cannot be deleted." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Delete Auth User via Admin API
      const { error: deleteAuthErr } = await adminClient.auth.admin.deleteUser(user_id);
      if (deleteAuthErr) {
        return new Response(
          JSON.stringify({ error: deleteAuthErr.message || "Failed to delete user account." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Delete corresponding profile if not automatically cascaded
      await adminClient.from("profiles").delete().eq("id", user_id);

      return new Response(
        JSON.stringify({
          success: true,
          message: `User "${targetProfile.display_name || user_id}" removed successfully.`
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // =========================================================================
    // ACTION: create-lab
    // =========================================================================
    if (action === "create-lab") {
      const { name } = body;

      if (!name || !name.trim()) {
        return new Response(
          JSON.stringify({ error: "Laboratory name is required." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const cleanName = name.trim();

      // Check for duplicate lab name (case-insensitive)
      const { data: existingLabs } = await adminClient
        .from("labs")
        .select("*");

      const duplicate = (existingLabs || []).find(l => {
        const lName = (l.name || l.lab_name || "").toLowerCase();
        return lName === cleanName.toLowerCase();
      });

      if (duplicate) {
        return new Response(
          JSON.stringify({ error: `A laboratory named "${cleanName}" already exists.` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Insert into public.labs
      let insertRes = await adminClient
        .from("labs")
        .insert({ name: cleanName })
        .select()
        .single();

      if (insertRes.error) {
        // Fallback to lab_name column if table schema uses lab_name
        insertRes = await adminClient
          .from("labs")
          .insert({ lab_name: cleanName })
          .select()
          .single();
      }

      if (insertRes.error) {
        throw insertRes.error;
      }

      return new Response(
        JSON.stringify({
          success: true,
          message: `Laboratory "${cleanName}" created successfully.`,
          lab: insertRes.data
        }),
        { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // =========================================================================
    // ACTION: delete-lab
    // =========================================================================
    if (action === "delete-lab") {
      const { lab_id } = body;

      if (!lab_id) {
        return new Response(
          JSON.stringify({ error: "Laboratory ID is required." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // 1. Check if users are currently assigned to this lab
      const { data: assignedUsers, error: userCheckErr } = await adminClient
        .from("profiles")
        .select("id, display_name")
        .eq("lab_id", lab_id);

      if (!userCheckErr && assignedUsers && assignedUsers.length > 0) {
        return new Response(
          JSON.stringify({
            error: `Cannot remove laboratory: ${assignedUsers.length} user(s) are currently assigned to this lab. Reassign or remove the users first.`
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // 2. Check if historical lab_requests exist for this lab
      try {
        const { data: labReqs } = await adminClient
          .from("lab_requests")
          .select("id")
          .eq("lab_id", lab_id)
          .limit(1);

        if (labReqs && labReqs.length > 0) {
          return new Response(
            JSON.stringify({
              error: "Cannot remove laboratory: Protected historical requisition records exist for this laboratory."
            }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      } catch {
        // Continue if table doesn't have lab_id column
      }

      // 3. Perform safe deletion of the lab
      const { error: deleteLabErr } = await adminClient
        .from("labs")
        .delete()
        .eq("id", lab_id);

      if (deleteLabErr) {
        return new Response(
          JSON.stringify({ error: deleteLabErr.message || "Failed to delete laboratory." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          message: "Laboratory removed successfully."
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: `Unknown action "${action}".` }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err: any) {
    console.error("Unhandled Edge Function error:", err);
    return new Response(
      JSON.stringify({ error: err.message || "An unexpected internal server error occurred." }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
