-- Unifica contatos duplicados pelo 9o digito BR (mesma conta: 55DDD9XXXXXXXX x 55DDDXXXXXXXX).
-- Mantem o contato COM 9 (canonico), move conversa/mensagens do SEM 9 pra ele e grava wa_id. Idempotente.
do $$
declare r record; conv_keep uuid; conv_drop uuid;
begin
  for r in
    select a.id as keep_id, b.id as drop_id, b.phone as wa_id, a.account_id
    from public.wa_contacts a
    join public.wa_contacts b on b.account_id = a.account_id
      and a.phone ~ '^55\d{2}9\d{8}$' and b.phone = substr(a.phone, 1, 4) || substr(a.phone, 6)
  loop
    update public.wa_contacts set wa_id = r.wa_id,
      name = coalesce(name, (select name from public.wa_contacts where id = r.drop_id)),
      last_inbound_at = greatest(last_inbound_at, (select last_inbound_at from public.wa_contacts where id = r.drop_id))
      where id = r.keep_id;
    select id into conv_keep from public.wa_conversations where contact_id = r.keep_id limit 1;
    select id into conv_drop from public.wa_conversations where contact_id = r.drop_id limit 1;
    if conv_drop is not null and conv_keep is not null then
      update public.wa_messages set conversation_id = conv_keep, contact_id = r.keep_id where conversation_id = conv_drop;
      update public.wa_internal_notes set conversation_id = conv_keep where conversation_id = conv_drop;
      update public.wa_conversations k set
        unread_count = k.unread_count + d.unread_count,
        last_message_at = greatest(k.last_message_at, d.last_message_at),
        last_message_preview = case when coalesce(d.last_message_at, 'epoch') > coalesce(k.last_message_at, 'epoch') then d.last_message_preview else k.last_message_preview end,
        last_direction = case when coalesce(d.last_message_at, 'epoch') > coalesce(k.last_message_at, 'epoch') then d.last_direction else k.last_direction end,
        window_expires_at = greatest(k.window_expires_at, d.window_expires_at),
        status = 'open', closed_at = null
      from public.wa_conversations d where k.id = conv_keep and d.id = conv_drop;
      delete from public.wa_conversations where id = conv_drop;
    elsif conv_drop is not null then
      update public.wa_conversations set contact_id = r.keep_id where id = conv_drop;
      update public.wa_messages set contact_id = r.keep_id where conversation_id = conv_drop;
    end if;
    update public.wa_messages set contact_id = r.keep_id where contact_id = r.drop_id;
    update public.whatsapp_api_sends set phone = (select phone from public.wa_contacts where id = r.keep_id) where phone = r.wa_id and account_id = r.account_id;
    delete from public.wa_contacts where id = r.drop_id;
    raise notice 'unificado: % <- %', r.keep_id, r.drop_id;
  end loop;
end $$;
