--
-- PostgreSQL database dump
--

\restrict fQnDjkcmklu1mwIdLChFvCV21SEOob06SEG0DMU7X8wwZgD18MKnKkS5iixR70X

-- Dumped from database version 16.11
-- Dumped by pg_dump version 16.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: case_insensitive; Type: COLLATION; Schema: public; Owner: netaris
--

CREATE COLLATION public.case_insensitive (provider = icu, deterministic = false, locale = 'und-u-ks-level2');


ALTER COLLATION public.case_insensitive OWNER TO netaris;

--
-- Name: perms_mode; Type: TYPE; Schema: public; Owner: netaris
--

CREATE TYPE public.perms_mode AS ENUM (
    'whitelist',
    'blacklist'
);


ALTER TYPE public.perms_mode OWNER TO netaris;

--
-- Name: auto_generate_netdoc_id(); Type: FUNCTION; Schema: public; Owner: netaris
--

CREATE FUNCTION public.auto_generate_netdoc_id() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.id IS NULL OR NEW.id = '' THEN
        NEW.id := find_earliest_netdoc_id();
    END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.auto_generate_netdoc_id() OWNER TO netaris;

--
-- Name: base32_to_int(text); Type: FUNCTION; Schema: public; Owner: netaris
--

CREATE FUNCTION public.base32_to_int(str text) RETURNS bigint
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    base32_chars TEXT COLLATE "C" := '0123456789abcdefghjkmnpqrstvwxyz';
    result BIGINT := 0;
    i INT;
    c TEXT;
    pos INT;
BEGIN
    str := lower(str);
    FOR i IN 1..length(str) LOOP
        c := substr(str, i, 1);
        -- Cast c to "C" collation to match base32_chars
        pos := strpos(base32_chars, c COLLATE "C") - 1;
        IF pos < 0 THEN
            RETURN NULL; -- Invalid character
        END IF;
        result := result * 32 + pos;
    END LOOP;
    RETURN result;
END;
$$;


ALTER FUNCTION public.base32_to_int(str text) OWNER TO netaris;

--
-- Name: cascade_perm_grant(); Type: FUNCTION; Schema: public; Owner: netaris
--

CREATE FUNCTION public.cascade_perm_grant() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
    entity_id TEXT := to_jsonb(NEW)->>TG_ARGV[0];
BEGIN
    IF NEW.permission_type = 'write' THEN
        EXECUTE format(
            'INSERT INTO %I (%I, permission_type, user_id, is_blacklist) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
            TG_TABLE_NAME, TG_ARGV[0]
        ) USING entity_id, 'comment', NEW.user_id, NEW.is_blacklist;
        EXECUTE format(
            'INSERT INTO %I (%I, permission_type, user_id, is_blacklist) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
            TG_TABLE_NAME, TG_ARGV[0]
        ) USING entity_id, 'read', NEW.user_id, NEW.is_blacklist;
    ELSIF NEW.permission_type = 'comment' THEN
        EXECUTE format(
            'INSERT INTO %I (%I, permission_type, user_id, is_blacklist) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
            TG_TABLE_NAME, TG_ARGV[0]
        ) USING entity_id, 'read', NEW.user_id, NEW.is_blacklist;
    END IF;
    RETURN NEW;
END;
$_$;


ALTER FUNCTION public.cascade_perm_grant() OWNER TO netaris;

--
-- Name: cascade_perm_revoke(); Type: FUNCTION; Schema: public; Owner: netaris
--

CREATE FUNCTION public.cascade_perm_revoke() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
    entity_id TEXT := to_jsonb(OLD)->>TG_ARGV[0];
BEGIN
    IF OLD.permission_type = 'read' THEN
        EXECUTE format(
            'DELETE FROM %I WHERE %I = $1 AND permission_type = $2 AND user_id IS NOT DISTINCT FROM $3 AND is_blacklist = $4',
            TG_TABLE_NAME, TG_ARGV[0]
        ) USING entity_id, 'comment', OLD.user_id, OLD.is_blacklist;
        EXECUTE format(
            'DELETE FROM %I WHERE %I = $1 AND permission_type = $2 AND user_id IS NOT DISTINCT FROM $3 AND is_blacklist = $4',
            TG_TABLE_NAME, TG_ARGV[0]
        ) USING entity_id, 'write', OLD.user_id, OLD.is_blacklist;
    ELSIF OLD.permission_type = 'comment' THEN
        EXECUTE format(
            'DELETE FROM %I WHERE %I = $1 AND permission_type = $2 AND user_id IS NOT DISTINCT FROM $3 AND is_blacklist = $4',
            TG_TABLE_NAME, TG_ARGV[0]
        ) USING entity_id, 'write', OLD.user_id, OLD.is_blacklist;
    END IF;
    RETURN OLD;
END;
$_$;


ALTER FUNCTION public.cascade_perm_revoke() OWNER TO netaris;

--
-- Name: cascade_perms_mode(); Type: FUNCTION; Schema: public; Owner: netaris
--

CREATE FUNCTION public.cascade_perms_mode() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.perms_mode_write = 'blacklist' AND OLD.perms_mode_write != 'blacklist' THEN
        NEW.perms_mode_comment := 'blacklist';
        NEW.perms_mode_read := 'blacklist';
    END IF;
    IF NEW.perms_mode_comment = 'blacklist' AND OLD.perms_mode_comment != 'blacklist' THEN
        NEW.perms_mode_read := 'blacklist';
    END IF;
    IF NEW.perms_mode_read = 'whitelist' AND OLD.perms_mode_read != 'whitelist' THEN
        NEW.perms_mode_comment := 'whitelist';
        NEW.perms_mode_write := 'whitelist';
    END IF;
    IF NEW.perms_mode_comment = 'whitelist' AND OLD.perms_mode_comment != 'whitelist' THEN
        NEW.perms_mode_write := 'whitelist';
    END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.cascade_perms_mode() OWNER TO netaris;

--
-- Name: create_space_jacket(); Type: FUNCTION; Schema: public; Owner: netaris
--

CREATE FUNCTION public.create_space_jacket() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    jacket_id TEXT;
BEGIN
    INSERT INTO netdoc (name, content, creator_id, is_unlisted, is_chat, is_jacket)
    VALUES (NEW.name, '', NEW.owner_id, false, false, true)
    RETURNING id INTO jacket_id;

    UPDATE spaces SET jacket = jacket_id WHERE id = NEW.id;

    INSERT INTO space_items (space_id, netdoc_id, order_key)
    VALUES (NEW.id, jacket_id, 0);

    RETURN NEW;
END;
$$;


ALTER FUNCTION public.create_space_jacket() OWNER TO netaris;

--
-- Name: create_user_homepage(); Type: FUNCTION; Schema: public; Owner: netaris
--

CREATE FUNCTION public.create_user_homepage() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    new_netdoc_id TEXT;
BEGIN
    INSERT INTO netdoc (name, content, creator_id, created_at, updated_at)
    VALUES (
        NEW.username || '''s Homepage',
        '',
        NEW.id,
        NOW(),
        NOW()
    )
    RETURNING id INTO new_netdoc_id;

    -- Creator gets explicit write and comment whitelist entries
    -- Read is public by default (perms_mode_read = 'blacklist')
    -- Creator read/write bypass is in application code
    INSERT INTO netdoc_permission (netdoc_id, permission_type, user_id)
    VALUES
        (new_netdoc_id, 'read', NEW.id),
        (new_netdoc_id, 'write', NEW.id),
        (new_netdoc_id, 'comment', NEW.id)
    ON CONFLICT DO NOTHING;

    UPDATE profile
    SET homepage = new_netdoc_id
    WHERE id = NEW.id;

    RETURN NEW;
END;
$$;


ALTER FUNCTION public.create_user_homepage() OWNER TO netaris;

--
-- Name: create_user_spaces(); Type: FUNCTION; Schema: public; Owner: netaris
--

CREATE FUNCTION public.create_user_spaces() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    profile_space_id TEXT;
    saved_space_id TEXT;
BEGIN
    -- Create profile space (public)
    INSERT INTO spaces (id, owner_id, name, description, is_profile)
    VALUES (find_earliest_space_id(), NEW.id, NEW.display_name || '''s Profile', '', true)
    RETURNING id INTO profile_space_id;

    -- Create saved/collection space (private — all whitelist)
    INSERT INTO spaces (id, owner_id, name, description, is_collection, perms_mode_read, perms_mode_comment, perms_mode_write)
    VALUES (find_earliest_space_id(), NEW.id, NEW.display_name || '''s Saved', '', true, 'whitelist', 'whitelist', 'whitelist')
    RETURNING id INTO saved_space_id;

    -- Add owner as member of both spaces
    INSERT INTO space_members (space_id, user_id, role)
    VALUES (profile_space_id, NEW.id, 'owner'), (saved_space_id, NEW.id, 'owner');

    -- Profile space is public by default (perms_mode_read = 'blacklist')
    -- Owner bypass is in application code

    RETURN NEW;
END;
$$;


ALTER FUNCTION public.create_user_spaces() OWNER TO netaris;

--
-- Name: find_earliest_netdoc_id(); Type: FUNCTION; Schema: public; Owner: netaris
--

CREATE FUNCTION public.find_earliest_netdoc_id() RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
    candidate BIGINT := 1;
    max_check BIGINT := 10000; -- Limit search to prevent infinite loops
BEGIN
    -- Find the smallest integer not in use
    WHILE candidate < max_check LOOP
        IF NOT EXISTS (SELECT 1 FROM netdoc WHERE id = int_to_base32(candidate)) THEN
            RETURN int_to_base32(candidate);
        END IF;
        candidate := candidate + 1;
    END LOOP;
    
    -- Fallback: use sequence if no gap found in first 10000
    RETURN int_to_base32(nextval('netdoc_id_seq'));
END;
$$;


ALTER FUNCTION public.find_earliest_netdoc_id() OWNER TO netaris;

--
-- Name: find_earliest_space_id(); Type: FUNCTION; Schema: public; Owner: netaris
--

CREATE FUNCTION public.find_earliest_space_id() RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
    candidate BIGINT := 1;
    max_check BIGINT := 10000;
BEGIN
    WHILE candidate < max_check LOOP
        IF NOT EXISTS (SELECT 1 FROM spaces WHERE id = int_to_base32(candidate)) THEN
            RETURN int_to_base32(candidate);
        END IF;
        candidate := candidate + 1;
    END LOOP;
    RETURN int_to_base32(nextval('space_id_seq'));
END;
$$;


ALTER FUNCTION public.find_earliest_space_id() OWNER TO netaris;

--
-- Name: int_to_base32(bigint); Type: FUNCTION; Schema: public; Owner: netaris
--

CREATE FUNCTION public.int_to_base32(num bigint) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    base32_chars TEXT := '0123456789abcdefghjkmnpqrstvwxyz';
    result TEXT := '';
    remainder INT;
BEGIN
    IF num = 0 THEN
        RETURN '0';
    END IF;

    WHILE num > 0 LOOP
        remainder := num % 32;
        result := substring(base32_chars from (remainder + 1) for 1) || result;
        num := num / 32;
    END LOOP;

    RETURN result;
END;
$$;


ALTER FUNCTION public.int_to_base32(num bigint) OWNER TO netaris;

--
-- Name: protect_owner_perm(); Type: FUNCTION; Schema: public; Owner: netaris
--

CREATE FUNCTION public.protect_owner_perm() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
    entity_id TEXT := to_jsonb(OLD)->>TG_ARGV[1];
    owner_id UUID;
BEGIN
    IF OLD.permission_type NOT IN ('read', 'write') OR OLD.user_id IS NULL THEN
        RETURN OLD;
    END IF;

    EXECUTE format('SELECT %I FROM %I WHERE id = $1', TG_ARGV[2], TG_ARGV[0])
    INTO owner_id USING entity_id;

    IF OLD.user_id = owner_id THEN
        RETURN NULL;
    END IF;

    RETURN OLD;
END;
$_$;


ALTER FUNCTION public.protect_owner_perm() OWNER TO netaris;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: dm_conversation; Type: TABLE; Schema: public; Owner: netaris
--

CREATE TABLE public.dm_conversation (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id_1 uuid NOT NULL,
    user_id_2 uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT dm_conversation_check CHECK ((user_id_1 < user_id_2))
);


ALTER TABLE public.dm_conversation OWNER TO netaris;

--
-- Name: dm_message; Type: TABLE; Schema: public; Owner: netaris
--

CREATE TABLE public.dm_message (
    id bigint NOT NULL,
    conversation_id uuid NOT NULL,
    message_netdoc_id text NOT NULL COLLATE public.case_insensitive,
    sender_id uuid,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.dm_message OWNER TO netaris;

--
-- Name: dm_message_id_seq; Type: SEQUENCE; Schema: public; Owner: netaris
--

CREATE SEQUENCE public.dm_message_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.dm_message_id_seq OWNER TO netaris;

--
-- Name: dm_message_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: netaris
--

ALTER SEQUENCE public.dm_message_id_seq OWNED BY public.dm_message.id;


--
-- Name: netdoc; Type: TABLE; Schema: public; Owner: netaris
--

CREATE TABLE public.netdoc (
    id text NOT NULL COLLATE public.case_insensitive,
    name character varying(500) NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    creator_id uuid,
    is_unlisted boolean DEFAULT false NOT NULL,
    is_chat boolean DEFAULT false NOT NULL,
    hide_history_from_non_editors boolean DEFAULT false NOT NULL,
    topic character varying(390) DEFAULT NULL::character varying,
    users_can_change_topic boolean DEFAULT false NOT NULL,
    status_message boolean DEFAULT false NOT NULL,
    is_jacket boolean DEFAULT false NOT NULL,
    perms_mode_read public.perms_mode DEFAULT 'blacklist'::public.perms_mode NOT NULL,
    perms_mode_comment public.perms_mode DEFAULT 'blacklist'::public.perms_mode NOT NULL,
    perms_mode_write public.perms_mode DEFAULT 'whitelist'::public.perms_mode NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT netdoc_id_check CHECK (((id COLLATE "C") ~ '^[a-zA-Z0-9]+$'::text)),
    CONSTRAINT status_message_requires_null_creator CHECK (((creator_id IS NOT NULL) OR (status_message = true))),
    CONSTRAINT topic_only_for_chat CHECK (((topic IS NULL) OR (is_chat = true))),
    CONSTRAINT users_can_change_topic_only_for_chat CHECK (((users_can_change_topic = false) OR (is_chat = true)))
);


ALTER TABLE public.netdoc OWNER TO netaris;

--
-- Name: netdoc_comment; Type: TABLE; Schema: public; Owner: netaris
--

CREATE TABLE public.netdoc_comment (
    id bigint NOT NULL,
    parent_netdoc_id text NOT NULL COLLATE public.case_insensitive,
    comment_netdoc_id text NOT NULL COLLATE public.case_insensitive,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.netdoc_comment OWNER TO netaris;

--
-- Name: netdoc_comment_id_seq; Type: SEQUENCE; Schema: public; Owner: netaris
--

CREATE SEQUENCE public.netdoc_comment_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.netdoc_comment_id_seq OWNER TO netaris;

--
-- Name: netdoc_comment_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: netaris
--

ALTER SEQUENCE public.netdoc_comment_id_seq OWNED BY public.netdoc_comment.id;


--
-- Name: netdoc_id_seq; Type: SEQUENCE; Schema: public; Owner: netaris
--

CREATE SEQUENCE public.netdoc_id_seq
    START WITH 2
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.netdoc_id_seq OWNER TO netaris;

--
-- Name: netdoc_notifications; Type: TABLE; Schema: public; Owner: netaris
--

CREATE TABLE public.netdoc_notifications (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    netdoc_id text NOT NULL COLLATE public.case_insensitive,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.netdoc_notifications OWNER TO netaris;

--
-- Name: netdoc_notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: netaris
--

CREATE SEQUENCE public.netdoc_notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.netdoc_notifications_id_seq OWNER TO netaris;

--
-- Name: netdoc_notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: netaris
--

ALTER SEQUENCE public.netdoc_notifications_id_seq OWNED BY public.netdoc_notifications.id;


--
-- Name: netdoc_permission; Type: TABLE; Schema: public; Owner: netaris
--

CREATE TABLE public.netdoc_permission (
    id bigint NOT NULL,
    netdoc_id text NOT NULL COLLATE public.case_insensitive,
    permission_type character varying(50) NOT NULL,
    user_id uuid,
    is_blacklist boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.netdoc_permission OWNER TO netaris;

--
-- Name: netdoc_permission_id_seq; Type: SEQUENCE; Schema: public; Owner: netaris
--

CREATE SEQUENCE public.netdoc_permission_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.netdoc_permission_id_seq OWNER TO netaris;

--
-- Name: netdoc_permission_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: netaris
--

ALTER SEQUENCE public.netdoc_permission_id_seq OWNED BY public.netdoc_permission.id;


--
-- Name: netdoc_version; Type: TABLE; Schema: public; Owner: netaris
--

CREATE TABLE public.netdoc_version (
    id bigint NOT NULL,
    netdoc_id text NOT NULL COLLATE public.case_insensitive,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    title character varying(500) NOT NULL,
    author uuid NOT NULL
);


ALTER TABLE public.netdoc_version OWNER TO netaris;

--
-- Name: netdoc_version_id_seq; Type: SEQUENCE; Schema: public; Owner: netaris
--

CREATE SEQUENCE public.netdoc_version_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.netdoc_version_id_seq OWNER TO netaris;

--
-- Name: netdoc_version_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: netaris
--

ALTER SEQUENCE public.netdoc_version_id_seq OWNED BY public.netdoc_version.id;


--
-- Name: netdoc_view; Type: TABLE; Schema: public; Owner: netaris
--

CREATE TABLE public.netdoc_view (
    id bigint NOT NULL,
    netdoc_id text NOT NULL COLLATE public.case_insensitive,
    viewer_id uuid NOT NULL,
    viewed_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.netdoc_view OWNER TO netaris;

--
-- Name: netdoc_view_id_seq; Type: SEQUENCE; Schema: public; Owner: netaris
--

CREATE SEQUENCE public.netdoc_view_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.netdoc_view_id_seq OWNER TO netaris;

--
-- Name: netdoc_view_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: netaris
--

ALTER SEQUENCE public.netdoc_view_id_seq OWNED BY public.netdoc_view.id;


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: netaris
--

CREATE TABLE public.notifications (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    netdoc_id text COLLATE public.case_insensitive,
    type character varying(50) NOT NULL,
    message text NOT NULL,
    content text,
    read boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    author_id uuid
);


ALTER TABLE public.notifications OWNER TO netaris;

--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: netaris
--

CREATE SEQUENCE public.notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.notifications_id_seq OWNER TO netaris;

--
-- Name: notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: netaris
--

ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;


--
-- Name: profile; Type: TABLE; Schema: public; Owner: netaris
--

CREATE TABLE public.profile (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    username text NOT NULL,
    display_name text NOT NULL,
    password text NOT NULL,
    joined_at timestamp with time zone DEFAULT now(),
    color character varying(6) DEFAULT 'd2b34e'::character varying,
    settings json DEFAULT '{}'::json,
    is_admin boolean DEFAULT false,
    homepage text COLLATE public.case_insensitive,
    CONSTRAINT profile_username_check CHECK ((username ~ '^[a-zA-Z0-9_]{1,15}$'::text))
);


ALTER TABLE public.profile OWNER TO netaris;

--
-- Name: space_folders; Type: TABLE; Schema: public; Owner: netaris
--

CREATE TABLE public.space_folders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    space_id text,
    parent_folder_id uuid,
    name character varying(255) NOT NULL,
    is_open boolean DEFAULT true,
    order_key integer NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT folder_has_owner CHECK (((user_id IS NOT NULL) OR (space_id IS NOT NULL)))
);


ALTER TABLE public.space_folders OWNER TO netaris;

--
-- Name: space_id_seq; Type: SEQUENCE; Schema: public; Owner: netaris
--

CREATE SEQUENCE public.space_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.space_id_seq OWNER TO netaris;

--
-- Name: space_items; Type: TABLE; Schema: public; Owner: netaris
--

CREATE TABLE public.space_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    space_id text,
    netdoc_id text NOT NULL COLLATE public.case_insensitive,
    folder_id uuid,
    order_key integer NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT item_has_owner CHECK (((user_id IS NOT NULL) OR (space_id IS NOT NULL)))
);


ALTER TABLE public.space_items OWNER TO netaris;

--
-- Name: space_members; Type: TABLE; Schema: public; Owner: netaris
--

CREATE TABLE public.space_members (
    id bigint NOT NULL,
    space_id text NOT NULL,
    user_id uuid NOT NULL,
    role character varying(50) DEFAULT 'member'::character varying NOT NULL,
    joined_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.space_members OWNER TO netaris;

--
-- Name: space_members_id_seq; Type: SEQUENCE; Schema: public; Owner: netaris
--

CREATE SEQUENCE public.space_members_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.space_members_id_seq OWNER TO netaris;

--
-- Name: space_members_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: netaris
--

ALTER SEQUENCE public.space_members_id_seq OWNED BY public.space_members.id;


--
-- Name: space_permission; Type: TABLE; Schema: public; Owner: netaris
--

CREATE TABLE public.space_permission (
    id bigint NOT NULL,
    space_id text NOT NULL,
    permission_type text NOT NULL,
    user_id uuid,
    is_blacklist boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT space_permission_permission_type_check CHECK ((permission_type = ANY (ARRAY['read'::text, 'comment'::text, 'write'::text])))
);


ALTER TABLE public.space_permission OWNER TO netaris;

--
-- Name: space_permission_id_seq; Type: SEQUENCE; Schema: public; Owner: netaris
--

CREATE SEQUENCE public.space_permission_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.space_permission_id_seq OWNER TO netaris;

--
-- Name: space_permission_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: netaris
--

ALTER SEQUENCE public.space_permission_id_seq OWNED BY public.space_permission.id;


--
-- Name: spaces; Type: TABLE; Schema: public; Owner: netaris
--

CREATE TABLE public.spaces (
    id text NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    owner_id uuid NOT NULL,
    is_profile boolean DEFAULT false NOT NULL,
    is_collection boolean DEFAULT false NOT NULL,
    jacket text,
    avatar_url text,
    perms_mode_read public.perms_mode DEFAULT 'blacklist'::public.perms_mode NOT NULL,
    perms_mode_comment public.perms_mode DEFAULT 'blacklist'::public.perms_mode NOT NULL,
    perms_mode_write public.perms_mode DEFAULT 'whitelist'::public.perms_mode NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.spaces OWNER TO netaris;

--
-- Name: tos_acceptance; Type: TABLE; Schema: public; Owner: netaris
--

CREATE TABLE public.tos_acceptance (
    id bigint NOT NULL,
    profile_id uuid NOT NULL,
    tos_version character varying(50) NOT NULL,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    ip_address character varying(45)
);


ALTER TABLE public.tos_acceptance OWNER TO netaris;

--
-- Name: tos_acceptance_id_seq; Type: SEQUENCE; Schema: public; Owner: netaris
--

CREATE SEQUENCE public.tos_acceptance_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.tos_acceptance_id_seq OWNER TO netaris;

--
-- Name: tos_acceptance_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: netaris
--

ALTER SEQUENCE public.tos_acceptance_id_seq OWNED BY public.tos_acceptance.id;


--
-- Name: user_space_subscriptions; Type: TABLE; Schema: public; Owner: netaris
--

CREATE TABLE public.user_space_subscriptions (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    space_id text NOT NULL,
    order_key integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.user_space_subscriptions OWNER TO netaris;

--
-- Name: user_space_subscriptions_id_seq; Type: SEQUENCE; Schema: public; Owner: netaris
--

CREATE SEQUENCE public.user_space_subscriptions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.user_space_subscriptions_id_seq OWNER TO netaris;

--
-- Name: user_space_subscriptions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: netaris
--

ALTER SEQUENCE public.user_space_subscriptions_id_seq OWNED BY public.user_space_subscriptions.id;


--
-- Name: dm_message id; Type: DEFAULT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.dm_message ALTER COLUMN id SET DEFAULT nextval('public.dm_message_id_seq'::regclass);


--
-- Name: netdoc_comment id; Type: DEFAULT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc_comment ALTER COLUMN id SET DEFAULT nextval('public.netdoc_comment_id_seq'::regclass);


--
-- Name: netdoc_notifications id; Type: DEFAULT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc_notifications ALTER COLUMN id SET DEFAULT nextval('public.netdoc_notifications_id_seq'::regclass);


--
-- Name: netdoc_permission id; Type: DEFAULT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc_permission ALTER COLUMN id SET DEFAULT nextval('public.netdoc_permission_id_seq'::regclass);


--
-- Name: netdoc_version id; Type: DEFAULT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc_version ALTER COLUMN id SET DEFAULT nextval('public.netdoc_version_id_seq'::regclass);


--
-- Name: netdoc_view id; Type: DEFAULT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc_view ALTER COLUMN id SET DEFAULT nextval('public.netdoc_view_id_seq'::regclass);


--
-- Name: notifications id; Type: DEFAULT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.notifications ALTER COLUMN id SET DEFAULT nextval('public.notifications_id_seq'::regclass);


--
-- Name: space_members id; Type: DEFAULT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.space_members ALTER COLUMN id SET DEFAULT nextval('public.space_members_id_seq'::regclass);


--
-- Name: space_permission id; Type: DEFAULT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.space_permission ALTER COLUMN id SET DEFAULT nextval('public.space_permission_id_seq'::regclass);


--
-- Name: tos_acceptance id; Type: DEFAULT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.tos_acceptance ALTER COLUMN id SET DEFAULT nextval('public.tos_acceptance_id_seq'::regclass);


--
-- Name: user_space_subscriptions id; Type: DEFAULT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.user_space_subscriptions ALTER COLUMN id SET DEFAULT nextval('public.user_space_subscriptions_id_seq'::regclass);


--
-- Data for Name: dm_conversation; Type: TABLE DATA; Schema: public; Owner: netaris
--

COPY public.dm_conversation (id, user_id_1, user_id_2, created_at) FROM stdin;
\.


--
-- Data for Name: dm_message; Type: TABLE DATA; Schema: public; Owner: netaris
--

COPY public.dm_message (id, conversation_id, message_netdoc_id, sender_id, created_at) FROM stdin;
\.


--
-- Data for Name: netdoc; Type: TABLE DATA; Schema: public; Owner: netaris
--

COPY public.netdoc (id, name, content, creator_id, is_unlisted, is_chat, hide_history_from_non_editors, topic, users_can_change_topic, status_message, is_jacket, perms_mode_read, perms_mode_comment, perms_mode_write, created_at, updated_at) FROM stdin;
1	netaris's Homepage		00000000-0000-0000-0000-000000000000	f	f	f	\N	f	f	f	blacklist	blacklist	whitelist	2026-02-07 22:13:09.959324+00	2026-02-07 22:13:09.959324+00
2	Netaris System's Profile		00000000-0000-0000-0000-000000000000	f	f	f	\N	f	f	t	blacklist	blacklist	whitelist	2026-02-07 22:13:09.959324+00	2026-02-07 22:13:09.959324+00
3	Netaris System's Saved		00000000-0000-0000-0000-000000000000	f	f	f	\N	f	f	t	blacklist	blacklist	whitelist	2026-02-07 22:13:09.959324+00	2026-02-07 22:13:09.959324+00
4	anonymous's Homepage		00000000-0000-0000-0000-000000000001	f	f	f	\N	f	f	f	blacklist	blacklist	whitelist	2026-02-07 22:13:09.959324+00	2026-02-07 22:13:09.959324+00
5	Anonymous User's Profile		00000000-0000-0000-0000-000000000001	f	f	f	\N	f	f	t	blacklist	blacklist	whitelist	2026-02-07 22:13:09.959324+00	2026-02-07 22:13:09.959324+00
6	Anonymous User's Saved		00000000-0000-0000-0000-000000000001	f	f	f	\N	f	f	t	blacklist	blacklist	whitelist	2026-02-07 22:13:09.959324+00	2026-02-07 22:13:09.959324+00
7	everyone's Homepage		00000000-0000-0000-0000-000000000002	f	f	f	\N	f	f	f	blacklist	blacklist	whitelist	2026-02-07 22:13:09.959324+00	2026-02-07 22:13:09.959324+00
8	Everyone's Profile		00000000-0000-0000-0000-000000000002	f	f	f	\N	f	f	t	blacklist	blacklist	whitelist	2026-02-07 22:13:09.959324+00	2026-02-07 22:13:09.959324+00
9	Everyone's Saved		00000000-0000-0000-0000-000000000002	f	f	f	\N	f	f	t	blacklist	blacklist	whitelist	2026-02-07 22:13:09.959324+00	2026-02-07 22:13:09.959324+00
a	bridgebot's Homepage		99999999-9999-9999-9999-999999999999	f	f	f	\N	f	f	f	blacklist	blacklist	whitelist	2026-02-07 22:13:09.959324+00	2026-02-07 22:13:09.959324+00
b	IRC Bridge Bot's Profile		99999999-9999-9999-9999-999999999999	f	f	f	\N	f	f	t	blacklist	blacklist	whitelist	2026-02-07 22:13:09.959324+00	2026-02-07 22:13:09.959324+00
c	IRC Bridge Bot's Saved		99999999-9999-9999-9999-999999999999	f	f	f	\N	f	f	t	blacklist	blacklist	whitelist	2026-02-07 22:13:09.959324+00	2026-02-07 22:13:09.959324+00
\.


--
-- Data for Name: netdoc_comment; Type: TABLE DATA; Schema: public; Owner: netaris
--

COPY public.netdoc_comment (id, parent_netdoc_id, comment_netdoc_id, created_at) FROM stdin;
\.


--
-- Data for Name: netdoc_notifications; Type: TABLE DATA; Schema: public; Owner: netaris
--

COPY public.netdoc_notifications (id, user_id, netdoc_id, created_at) FROM stdin;
\.


--
-- Data for Name: netdoc_permission; Type: TABLE DATA; Schema: public; Owner: netaris
--

COPY public.netdoc_permission (id, netdoc_id, permission_type, user_id, is_blacklist, created_at) FROM stdin;
1	1	read	00000000-0000-0000-0000-000000000000	f	2026-02-07 22:13:09.959324+00
2	1	write	00000000-0000-0000-0000-000000000000	f	2026-02-07 22:13:09.959324+00
3	1	comment	00000000-0000-0000-0000-000000000000	f	2026-02-07 22:13:09.959324+00
4	4	read	00000000-0000-0000-0000-000000000001	f	2026-02-07 22:13:09.959324+00
5	4	write	00000000-0000-0000-0000-000000000001	f	2026-02-07 22:13:09.959324+00
6	4	comment	00000000-0000-0000-0000-000000000001	f	2026-02-07 22:13:09.959324+00
7	7	read	00000000-0000-0000-0000-000000000002	f	2026-02-07 22:13:09.959324+00
8	7	write	00000000-0000-0000-0000-000000000002	f	2026-02-07 22:13:09.959324+00
9	7	comment	00000000-0000-0000-0000-000000000002	f	2026-02-07 22:13:09.959324+00
10	a	read	99999999-9999-9999-9999-999999999999	f	2026-02-07 22:13:09.959324+00
11	a	write	99999999-9999-9999-9999-999999999999	f	2026-02-07 22:13:09.959324+00
12	a	comment	99999999-9999-9999-9999-999999999999	f	2026-02-07 22:13:09.959324+00
\.


--
-- Data for Name: netdoc_version; Type: TABLE DATA; Schema: public; Owner: netaris
--

COPY public.netdoc_version (id, netdoc_id, content, created_at, title, author) FROM stdin;
\.


--
-- Data for Name: netdoc_view; Type: TABLE DATA; Schema: public; Owner: netaris
--

COPY public.netdoc_view (id, netdoc_id, viewer_id, viewed_at) FROM stdin;
\.


--
-- Data for Name: notifications; Type: TABLE DATA; Schema: public; Owner: netaris
--

COPY public.notifications (id, user_id, netdoc_id, type, message, content, read, created_at, author_id) FROM stdin;
\.


--
-- Data for Name: profile; Type: TABLE DATA; Schema: public; Owner: netaris
--

COPY public.profile (id, username, display_name, password, joined_at, color, settings, is_admin, homepage) FROM stdin;
00000000-0000-0000-0000-000000000001	anonymous	Anonymous User		2026-01-31 22:13:09.959324+00	d2b34e	{}	f	4
00000000-0000-0000-0000-000000000002	everyone	Everyone		2026-01-31 22:13:09.959324+00	d2b34e	{}	f	7
99999999-9999-9999-9999-999999999999	bridgebot	IRC Bridge Bot	$2b$10$XnIXXedPP70KRm35wuNJVeLR00L9hiW1FA6bvPZE4PyRgvSRIAWbC	2026-01-31 22:13:09.959324+00	d2b34e	{}	f	a
00000000-0000-0000-0000-000000000000	netaris	Netaris System	$2b$10$HCNO0mhrwuX6wYc4NwEjhOJNoZgL/cNLnTfvbHggKfYw6VIIDlE6.	2026-01-31 22:13:09.959324+00	d2b34e	{}	t	1
\.


--
-- Data for Name: space_folders; Type: TABLE DATA; Schema: public; Owner: netaris
--

COPY public.space_folders (id, user_id, space_id, parent_folder_id, name, is_open, order_key, created_at) FROM stdin;
\.


--
-- Data for Name: space_items; Type: TABLE DATA; Schema: public; Owner: netaris
--

COPY public.space_items (id, user_id, space_id, netdoc_id, folder_id, order_key, created_at) FROM stdin;
89d70624-6994-4045-84da-bf345ed5f946	\N	1	2	\N	0	2026-02-07 22:13:09.959324+00
63125422-a58b-4423-b667-e21e826cea84	\N	2	3	\N	0	2026-02-07 22:13:09.959324+00
f3daf0ef-7ac2-4091-90de-33c6fc4b542a	\N	3	5	\N	0	2026-02-07 22:13:09.959324+00
b102d450-6bd5-407d-89d2-d7dddab82dad	\N	4	6	\N	0	2026-02-07 22:13:09.959324+00
6fb9d5e3-1dbb-4505-ba3b-ca448caeb939	\N	5	8	\N	0	2026-02-07 22:13:09.959324+00
119586e6-d788-45b5-bd02-2c9a8e5e205d	\N	6	9	\N	0	2026-02-07 22:13:09.959324+00
3f367c94-ec0f-4bed-abad-fc78607e6bca	\N	7	b	\N	0	2026-02-07 22:13:09.959324+00
71523998-eb01-4a1f-9325-c535f5705e8a	\N	8	c	\N	0	2026-02-07 22:13:09.959324+00
\.


--
-- Data for Name: space_members; Type: TABLE DATA; Schema: public; Owner: netaris
--

COPY public.space_members (id, space_id, user_id, role, joined_at) FROM stdin;
1	1	00000000-0000-0000-0000-000000000000	owner	2026-02-07 22:13:09.959324+00
2	2	00000000-0000-0000-0000-000000000000	owner	2026-02-07 22:13:09.959324+00
3	3	00000000-0000-0000-0000-000000000001	owner	2026-02-07 22:13:09.959324+00
4	4	00000000-0000-0000-0000-000000000001	owner	2026-02-07 22:13:09.959324+00
5	5	00000000-0000-0000-0000-000000000002	owner	2026-02-07 22:13:09.959324+00
6	6	00000000-0000-0000-0000-000000000002	owner	2026-02-07 22:13:09.959324+00
7	7	99999999-9999-9999-9999-999999999999	owner	2026-02-07 22:13:09.959324+00
8	8	99999999-9999-9999-9999-999999999999	owner	2026-02-07 22:13:09.959324+00
\.


--
-- Data for Name: space_permission; Type: TABLE DATA; Schema: public; Owner: netaris
--

COPY public.space_permission (id, space_id, permission_type, user_id, is_blacklist, created_at) FROM stdin;
\.


--
-- Data for Name: spaces; Type: TABLE DATA; Schema: public; Owner: netaris
--

COPY public.spaces (id, name, description, owner_id, is_profile, is_collection, jacket, avatar_url, perms_mode_read, perms_mode_comment, perms_mode_write, created_at, updated_at) FROM stdin;
1	Netaris System's Profile		00000000-0000-0000-0000-000000000000	t	f	2	\N	blacklist	blacklist	whitelist	2026-02-07 22:13:09.959324+00	2026-02-07 22:13:09.959324+00
2	Netaris System's Saved		00000000-0000-0000-0000-000000000000	f	t	3	\N	whitelist	whitelist	whitelist	2026-02-07 22:13:09.959324+00	2026-02-07 22:13:09.959324+00
3	Anonymous User's Profile		00000000-0000-0000-0000-000000000001	t	f	5	\N	blacklist	blacklist	whitelist	2026-02-07 22:13:09.959324+00	2026-02-07 22:13:09.959324+00
4	Anonymous User's Saved		00000000-0000-0000-0000-000000000001	f	t	6	\N	whitelist	whitelist	whitelist	2026-02-07 22:13:09.959324+00	2026-02-07 22:13:09.959324+00
5	Everyone's Profile		00000000-0000-0000-0000-000000000002	t	f	8	\N	blacklist	blacklist	whitelist	2026-02-07 22:13:09.959324+00	2026-02-07 22:13:09.959324+00
6	Everyone's Saved		00000000-0000-0000-0000-000000000002	f	t	9	\N	whitelist	whitelist	whitelist	2026-02-07 22:13:09.959324+00	2026-02-07 22:13:09.959324+00
7	IRC Bridge Bot's Profile		99999999-9999-9999-9999-999999999999	t	f	b	\N	blacklist	blacklist	whitelist	2026-02-07 22:13:09.959324+00	2026-02-07 22:13:09.959324+00
8	IRC Bridge Bot's Saved		99999999-9999-9999-9999-999999999999	f	t	c	\N	whitelist	whitelist	whitelist	2026-02-07 22:13:09.959324+00	2026-02-07 22:13:09.959324+00
\.


--
-- Data for Name: tos_acceptance; Type: TABLE DATA; Schema: public; Owner: netaris
--

COPY public.tos_acceptance (id, profile_id, tos_version, accepted_at, ip_address) FROM stdin;
\.


--
-- Data for Name: user_space_subscriptions; Type: TABLE DATA; Schema: public; Owner: netaris
--

COPY public.user_space_subscriptions (id, user_id, space_id, order_key, created_at) FROM stdin;
\.


--
-- Name: dm_message_id_seq; Type: SEQUENCE SET; Schema: public; Owner: netaris
--

SELECT pg_catalog.setval('public.dm_message_id_seq', 1, false);


--
-- Name: netdoc_comment_id_seq; Type: SEQUENCE SET; Schema: public; Owner: netaris
--

SELECT pg_catalog.setval('public.netdoc_comment_id_seq', 1, false);


--
-- Name: netdoc_id_seq; Type: SEQUENCE SET; Schema: public; Owner: netaris
--

SELECT pg_catalog.setval('public.netdoc_id_seq', 2, false);


--
-- Name: netdoc_notifications_id_seq; Type: SEQUENCE SET; Schema: public; Owner: netaris
--

SELECT pg_catalog.setval('public.netdoc_notifications_id_seq', 1, false);


--
-- Name: netdoc_permission_id_seq; Type: SEQUENCE SET; Schema: public; Owner: netaris
--

SELECT pg_catalog.setval('public.netdoc_permission_id_seq', 12, true);


--
-- Name: netdoc_version_id_seq; Type: SEQUENCE SET; Schema: public; Owner: netaris
--

SELECT pg_catalog.setval('public.netdoc_version_id_seq', 1, false);


--
-- Name: netdoc_view_id_seq; Type: SEQUENCE SET; Schema: public; Owner: netaris
--

SELECT pg_catalog.setval('public.netdoc_view_id_seq', 1, false);


--
-- Name: notifications_id_seq; Type: SEQUENCE SET; Schema: public; Owner: netaris
--

SELECT pg_catalog.setval('public.notifications_id_seq', 1, false);


--
-- Name: space_id_seq; Type: SEQUENCE SET; Schema: public; Owner: netaris
--

SELECT pg_catalog.setval('public.space_id_seq', 1, false);


--
-- Name: space_members_id_seq; Type: SEQUENCE SET; Schema: public; Owner: netaris
--

SELECT pg_catalog.setval('public.space_members_id_seq', 8, true);


--
-- Name: space_permission_id_seq; Type: SEQUENCE SET; Schema: public; Owner: netaris
--

SELECT pg_catalog.setval('public.space_permission_id_seq', 1, false);


--
-- Name: tos_acceptance_id_seq; Type: SEQUENCE SET; Schema: public; Owner: netaris
--

SELECT pg_catalog.setval('public.tos_acceptance_id_seq', 1, false);


--
-- Name: user_space_subscriptions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: netaris
--

SELECT pg_catalog.setval('public.user_space_subscriptions_id_seq', 1, false);


--
-- Name: dm_conversation dm_conversation_pkey; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.dm_conversation
    ADD CONSTRAINT dm_conversation_pkey PRIMARY KEY (id);


--
-- Name: dm_conversation dm_conversation_user_id_1_user_id_2_key; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.dm_conversation
    ADD CONSTRAINT dm_conversation_user_id_1_user_id_2_key UNIQUE (user_id_1, user_id_2);


--
-- Name: dm_message dm_message_conversation_id_message_netdoc_id_key; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.dm_message
    ADD CONSTRAINT dm_message_conversation_id_message_netdoc_id_key UNIQUE (conversation_id, message_netdoc_id);


--
-- Name: dm_message dm_message_pkey; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.dm_message
    ADD CONSTRAINT dm_message_pkey PRIMARY KEY (id);


--
-- Name: netdoc_comment netdoc_comment_parent_netdoc_id_comment_netdoc_id_key; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc_comment
    ADD CONSTRAINT netdoc_comment_parent_netdoc_id_comment_netdoc_id_key UNIQUE (parent_netdoc_id, comment_netdoc_id);


--
-- Name: netdoc_comment netdoc_comment_pkey; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc_comment
    ADD CONSTRAINT netdoc_comment_pkey PRIMARY KEY (id);


--
-- Name: netdoc_notifications netdoc_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc_notifications
    ADD CONSTRAINT netdoc_notifications_pkey PRIMARY KEY (id);


--
-- Name: netdoc_notifications netdoc_notifications_user_id_netdoc_id_key; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc_notifications
    ADD CONSTRAINT netdoc_notifications_user_id_netdoc_id_key UNIQUE (user_id, netdoc_id);


--
-- Name: netdoc_permission netdoc_permission_netdoc_id_permission_type_user_id_is_blac_key; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc_permission
    ADD CONSTRAINT netdoc_permission_netdoc_id_permission_type_user_id_is_blac_key UNIQUE (netdoc_id, permission_type, user_id, is_blacklist);


--
-- Name: netdoc_permission netdoc_permission_pkey; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc_permission
    ADD CONSTRAINT netdoc_permission_pkey PRIMARY KEY (id);


--
-- Name: netdoc netdoc_pkey; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc
    ADD CONSTRAINT netdoc_pkey PRIMARY KEY (id);


--
-- Name: netdoc_version netdoc_version_pkey; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc_version
    ADD CONSTRAINT netdoc_version_pkey PRIMARY KEY (id);


--
-- Name: netdoc_view netdoc_view_netdoc_id_viewer_id_key; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc_view
    ADD CONSTRAINT netdoc_view_netdoc_id_viewer_id_key UNIQUE (netdoc_id, viewer_id);


--
-- Name: netdoc_view netdoc_view_pkey; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc_view
    ADD CONSTRAINT netdoc_view_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: profile profile_pkey; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.profile
    ADD CONSTRAINT profile_pkey PRIMARY KEY (id);


--
-- Name: profile profile_username_key; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.profile
    ADD CONSTRAINT profile_username_key UNIQUE (username);


--
-- Name: space_folders space_folders_pkey; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.space_folders
    ADD CONSTRAINT space_folders_pkey PRIMARY KEY (id);


--
-- Name: space_folders space_folders_user_id_parent_folder_id_order_key_key; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.space_folders
    ADD CONSTRAINT space_folders_user_id_parent_folder_id_order_key_key UNIQUE (user_id, parent_folder_id, order_key);


--
-- Name: space_items space_items_pkey; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.space_items
    ADD CONSTRAINT space_items_pkey PRIMARY KEY (id);


--
-- Name: space_items space_items_user_id_folder_id_order_key_key; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.space_items
    ADD CONSTRAINT space_items_user_id_folder_id_order_key_key UNIQUE (user_id, folder_id, order_key);


--
-- Name: space_items space_items_user_id_netdoc_id_key; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.space_items
    ADD CONSTRAINT space_items_user_id_netdoc_id_key UNIQUE (user_id, netdoc_id);


--
-- Name: space_members space_members_pkey; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.space_members
    ADD CONSTRAINT space_members_pkey PRIMARY KEY (id);


--
-- Name: space_members space_members_space_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.space_members
    ADD CONSTRAINT space_members_space_id_user_id_key UNIQUE (space_id, user_id);


--
-- Name: space_permission space_permission_pkey; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.space_permission
    ADD CONSTRAINT space_permission_pkey PRIMARY KEY (id);


--
-- Name: space_permission space_permission_space_id_permission_type_user_id_is_blackl_key; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.space_permission
    ADD CONSTRAINT space_permission_space_id_permission_type_user_id_is_blackl_key UNIQUE (space_id, permission_type, user_id, is_blacklist);


--
-- Name: spaces spaces_jacket_key; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.spaces
    ADD CONSTRAINT spaces_jacket_key UNIQUE (jacket);


--
-- Name: spaces spaces_pkey; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.spaces
    ADD CONSTRAINT spaces_pkey PRIMARY KEY (id);


--
-- Name: tos_acceptance tos_acceptance_pkey; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.tos_acceptance
    ADD CONSTRAINT tos_acceptance_pkey PRIMARY KEY (id);


--
-- Name: user_space_subscriptions user_space_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.user_space_subscriptions
    ADD CONSTRAINT user_space_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: user_space_subscriptions user_space_subscriptions_user_id_space_id_key; Type: CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.user_space_subscriptions
    ADD CONSTRAINT user_space_subscriptions_user_id_space_id_key UNIQUE (user_id, space_id);


--
-- Name: idx_dm_conversation_users; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_dm_conversation_users ON public.dm_conversation USING btree (user_id_1, user_id_2);


--
-- Name: idx_dm_message_conversation; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_dm_message_conversation ON public.dm_message USING btree (conversation_id);


--
-- Name: idx_dm_message_created; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_dm_message_created ON public.dm_message USING btree (created_at DESC);


--
-- Name: idx_dm_message_sender; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_dm_message_sender ON public.dm_message USING btree (sender_id);


--
-- Name: idx_folders_parent; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_folders_parent ON public.space_folders USING btree (parent_folder_id) WHERE (parent_folder_id IS NOT NULL);


--
-- Name: idx_folders_user; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_folders_user ON public.space_folders USING btree (user_id);


--
-- Name: idx_netdoc_notifications_user; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_netdoc_notifications_user ON public.netdoc_notifications USING btree (user_id);


--
-- Name: idx_netdoc_permission_lookup; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_netdoc_permission_lookup ON public.netdoc_permission USING btree (netdoc_id, permission_type, user_id);


--
-- Name: idx_netdoc_permission_netdoc; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_netdoc_permission_netdoc ON public.netdoc_permission USING btree (netdoc_id);


--
-- Name: idx_netdoc_permission_type; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_netdoc_permission_type ON public.netdoc_permission USING btree (permission_type);


--
-- Name: idx_netdoc_permission_user; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_netdoc_permission_user ON public.netdoc_permission USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: idx_netdoc_view_netdoc; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_netdoc_view_netdoc ON public.netdoc_view USING btree (netdoc_id);


--
-- Name: idx_netdoc_view_time; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_netdoc_view_time ON public.netdoc_view USING btree (viewed_at);


--
-- Name: idx_notifications_read; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_notifications_read ON public.notifications USING btree (read);


--
-- Name: idx_notifications_user; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_notifications_user ON public.notifications USING btree (user_id);


--
-- Name: idx_profile_username; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_profile_username ON public.profile USING btree (username);


--
-- Name: idx_sidebar_folder; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_sidebar_folder ON public.space_items USING btree (folder_id) WHERE (folder_id IS NOT NULL);


--
-- Name: idx_sidebar_netdoc; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_sidebar_netdoc ON public.space_items USING btree (netdoc_id);


--
-- Name: idx_sidebar_user_order; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_sidebar_user_order ON public.space_items USING btree (user_id, order_key);


--
-- Name: idx_space_members_space; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_space_members_space ON public.space_members USING btree (space_id);


--
-- Name: idx_space_members_user; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_space_members_user ON public.space_members USING btree (user_id);


--
-- Name: idx_space_permission_space_type; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_space_permission_space_type ON public.space_permission USING btree (space_id, permission_type);


--
-- Name: idx_space_permission_user; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_space_permission_user ON public.space_permission USING btree (user_id);


--
-- Name: idx_spaces_collection; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_spaces_collection ON public.spaces USING btree (owner_id, is_collection) WHERE (is_collection = true);


--
-- Name: idx_spaces_owner; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_spaces_owner ON public.spaces USING btree (owner_id);


--
-- Name: idx_spaces_profile; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_spaces_profile ON public.spaces USING btree (owner_id, is_profile) WHERE (is_profile = true);


--
-- Name: idx_tos_profile; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_tos_profile ON public.tos_acceptance USING btree (profile_id);


--
-- Name: idx_tos_version; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_tos_version ON public.tos_acceptance USING btree (tos_version);


--
-- Name: idx_user_space_subscriptions_user_order; Type: INDEX; Schema: public; Owner: netaris
--

CREATE INDEX idx_user_space_subscriptions_user_order ON public.user_space_subscriptions USING btree (user_id, order_key);


--
-- Name: netdoc trigger_auto_generate_netdoc_id; Type: TRIGGER; Schema: public; Owner: netaris
--

CREATE TRIGGER trigger_auto_generate_netdoc_id BEFORE INSERT ON public.netdoc FOR EACH ROW EXECUTE FUNCTION public.auto_generate_netdoc_id();


--
-- Name: netdoc_permission trigger_cascade_perm_grant; Type: TRIGGER; Schema: public; Owner: netaris
--

CREATE TRIGGER trigger_cascade_perm_grant AFTER INSERT ON public.netdoc_permission FOR EACH ROW EXECUTE FUNCTION public.cascade_perm_grant('netdoc_id');


--
-- Name: space_permission trigger_cascade_perm_grant; Type: TRIGGER; Schema: public; Owner: netaris
--

CREATE TRIGGER trigger_cascade_perm_grant AFTER INSERT ON public.space_permission FOR EACH ROW EXECUTE FUNCTION public.cascade_perm_grant('space_id');


--
-- Name: netdoc_permission trigger_cascade_perm_revoke; Type: TRIGGER; Schema: public; Owner: netaris
--

CREATE TRIGGER trigger_cascade_perm_revoke AFTER DELETE ON public.netdoc_permission FOR EACH ROW EXECUTE FUNCTION public.cascade_perm_revoke('netdoc_id');


--
-- Name: space_permission trigger_cascade_perm_revoke; Type: TRIGGER; Schema: public; Owner: netaris
--

CREATE TRIGGER trigger_cascade_perm_revoke AFTER DELETE ON public.space_permission FOR EACH ROW EXECUTE FUNCTION public.cascade_perm_revoke('space_id');


--
-- Name: netdoc trigger_cascade_perms_mode; Type: TRIGGER; Schema: public; Owner: netaris
--

CREATE TRIGGER trigger_cascade_perms_mode BEFORE UPDATE ON public.netdoc FOR EACH ROW EXECUTE FUNCTION public.cascade_perms_mode();


--
-- Name: spaces trigger_cascade_perms_mode; Type: TRIGGER; Schema: public; Owner: netaris
--

CREATE TRIGGER trigger_cascade_perms_mode BEFORE UPDATE ON public.spaces FOR EACH ROW EXECUTE FUNCTION public.cascade_perms_mode();


--
-- Name: spaces trigger_create_space_jacket; Type: TRIGGER; Schema: public; Owner: netaris
--

CREATE TRIGGER trigger_create_space_jacket AFTER INSERT ON public.spaces FOR EACH ROW EXECUTE FUNCTION public.create_space_jacket();


--
-- Name: profile trigger_create_user_homepage; Type: TRIGGER; Schema: public; Owner: netaris
--

CREATE TRIGGER trigger_create_user_homepage AFTER INSERT ON public.profile FOR EACH ROW EXECUTE FUNCTION public.create_user_homepage();


--
-- Name: profile trigger_create_user_spaces; Type: TRIGGER; Schema: public; Owner: netaris
--

CREATE TRIGGER trigger_create_user_spaces AFTER INSERT ON public.profile FOR EACH ROW EXECUTE FUNCTION public.create_user_spaces();


--
-- Name: netdoc_permission trigger_protect_owner_perm; Type: TRIGGER; Schema: public; Owner: netaris
--

CREATE TRIGGER trigger_protect_owner_perm BEFORE DELETE ON public.netdoc_permission FOR EACH ROW EXECUTE FUNCTION public.protect_owner_perm('netdoc', 'netdoc_id', 'creator_id');


--
-- Name: space_permission trigger_protect_owner_perm; Type: TRIGGER; Schema: public; Owner: netaris
--

CREATE TRIGGER trigger_protect_owner_perm BEFORE DELETE ON public.space_permission FOR EACH ROW EXECUTE FUNCTION public.protect_owner_perm('spaces', 'space_id', 'owner_id');


--
-- Name: dm_conversation dm_conversation_user_id_1_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.dm_conversation
    ADD CONSTRAINT dm_conversation_user_id_1_fkey FOREIGN KEY (user_id_1) REFERENCES public.profile(id) ON DELETE CASCADE;


--
-- Name: dm_conversation dm_conversation_user_id_2_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.dm_conversation
    ADD CONSTRAINT dm_conversation_user_id_2_fkey FOREIGN KEY (user_id_2) REFERENCES public.profile(id) ON DELETE CASCADE;


--
-- Name: dm_message dm_message_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.dm_message
    ADD CONSTRAINT dm_message_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.dm_conversation(id) ON DELETE CASCADE;


--
-- Name: dm_message dm_message_message_netdoc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.dm_message
    ADD CONSTRAINT dm_message_message_netdoc_id_fkey FOREIGN KEY (message_netdoc_id) REFERENCES public.netdoc(id) ON DELETE CASCADE;


--
-- Name: dm_message dm_message_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.dm_message
    ADD CONSTRAINT dm_message_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.profile(id) ON DELETE CASCADE;


--
-- Name: netdoc_comment netdoc_comment_comment_netdoc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc_comment
    ADD CONSTRAINT netdoc_comment_comment_netdoc_id_fkey FOREIGN KEY (comment_netdoc_id) REFERENCES public.netdoc(id) ON DELETE CASCADE;


--
-- Name: netdoc_comment netdoc_comment_parent_netdoc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc_comment
    ADD CONSTRAINT netdoc_comment_parent_netdoc_id_fkey FOREIGN KEY (parent_netdoc_id) REFERENCES public.netdoc(id) ON DELETE CASCADE;


--
-- Name: netdoc netdoc_creator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc
    ADD CONSTRAINT netdoc_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.profile(id) ON DELETE CASCADE;


--
-- Name: netdoc_notifications netdoc_notifications_netdoc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc_notifications
    ADD CONSTRAINT netdoc_notifications_netdoc_id_fkey FOREIGN KEY (netdoc_id) REFERENCES public.netdoc(id) ON DELETE CASCADE;


--
-- Name: netdoc_notifications netdoc_notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc_notifications
    ADD CONSTRAINT netdoc_notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profile(id) ON DELETE CASCADE;


--
-- Name: netdoc_permission netdoc_permission_netdoc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc_permission
    ADD CONSTRAINT netdoc_permission_netdoc_id_fkey FOREIGN KEY (netdoc_id) REFERENCES public.netdoc(id) ON DELETE CASCADE;


--
-- Name: netdoc_permission netdoc_permission_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc_permission
    ADD CONSTRAINT netdoc_permission_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profile(id) ON DELETE CASCADE;


--
-- Name: netdoc_version netdoc_version_author_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc_version
    ADD CONSTRAINT netdoc_version_author_fkey FOREIGN KEY (author) REFERENCES public.profile(id);


--
-- Name: netdoc_version netdoc_version_netdoc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc_version
    ADD CONSTRAINT netdoc_version_netdoc_id_fkey FOREIGN KEY (netdoc_id) REFERENCES public.netdoc(id) ON DELETE CASCADE;


--
-- Name: netdoc_view netdoc_view_netdoc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc_view
    ADD CONSTRAINT netdoc_view_netdoc_id_fkey FOREIGN KEY (netdoc_id) REFERENCES public.netdoc(id) ON DELETE CASCADE;


--
-- Name: netdoc_view netdoc_view_viewer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.netdoc_view
    ADD CONSTRAINT netdoc_view_viewer_id_fkey FOREIGN KEY (viewer_id) REFERENCES public.profile(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.profile(id) ON DELETE SET NULL;


--
-- Name: notifications notifications_netdoc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_netdoc_id_fkey FOREIGN KEY (netdoc_id) REFERENCES public.netdoc(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profile(id) ON DELETE CASCADE;


--
-- Name: profile profile_homepage_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.profile
    ADD CONSTRAINT profile_homepage_fkey FOREIGN KEY (homepage) REFERENCES public.netdoc(id);


--
-- Name: space_folders space_folders_parent_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.space_folders
    ADD CONSTRAINT space_folders_parent_folder_id_fkey FOREIGN KEY (parent_folder_id) REFERENCES public.space_folders(id) ON DELETE CASCADE;


--
-- Name: space_folders space_folders_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.space_folders
    ADD CONSTRAINT space_folders_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;


--
-- Name: space_folders space_folders_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.space_folders
    ADD CONSTRAINT space_folders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profile(id) ON DELETE CASCADE;


--
-- Name: space_items space_items_folder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.space_items
    ADD CONSTRAINT space_items_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES public.space_folders(id) ON DELETE SET NULL;


--
-- Name: space_items space_items_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.space_items
    ADD CONSTRAINT space_items_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;


--
-- Name: space_items space_items_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.space_items
    ADD CONSTRAINT space_items_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profile(id) ON DELETE CASCADE;


--
-- Name: space_members space_members_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.space_members
    ADD CONSTRAINT space_members_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;


--
-- Name: space_members space_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.space_members
    ADD CONSTRAINT space_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profile(id) ON DELETE CASCADE;


--
-- Name: space_permission space_permission_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.space_permission
    ADD CONSTRAINT space_permission_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;


--
-- Name: space_permission space_permission_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.space_permission
    ADD CONSTRAINT space_permission_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profile(id) ON DELETE CASCADE;


--
-- Name: spaces spaces_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.spaces
    ADD CONSTRAINT spaces_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.profile(id) ON DELETE CASCADE;


--
-- Name: tos_acceptance tos_acceptance_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.tos_acceptance
    ADD CONSTRAINT tos_acceptance_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.profile(id) ON DELETE CASCADE;


--
-- Name: user_space_subscriptions user_space_subscriptions_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.user_space_subscriptions
    ADD CONSTRAINT user_space_subscriptions_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id) ON DELETE CASCADE;


--
-- Name: user_space_subscriptions user_space_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: netaris
--

ALTER TABLE ONLY public.user_space_subscriptions
    ADD CONSTRAINT user_space_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profile(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict fQnDjkcmklu1mwIdLChFvCV21SEOob06SEG0DMU7X8wwZgD18MKnKkS5iixR70X

