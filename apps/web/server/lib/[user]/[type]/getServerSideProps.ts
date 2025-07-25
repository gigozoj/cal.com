import { type GetServerSidePropsContext } from "next";
import type { Session } from "next-auth";
import { z } from "zod";

import { getServerSession } from "@calcom/features/auth/lib/getServerSession";
import type { GetBookingType } from "@calcom/features/bookings/lib/get-booking";
import { getBookingForReschedule, getBookingForSeatedEvent } from "@calcom/features/bookings/lib/get-booking";
import { orgDomainConfig } from "@calcom/features/ee/organizations/lib/orgDomains";
import type { getPublicEvent } from "@calcom/features/eventtypes/lib/getPublicEvent";
import { getUsernameList } from "@calcom/lib/defaultEvents";
import { shouldHideBrandingForUserEvent } from "@calcom/lib/hideBranding";
import { EventRepository } from "@calcom/lib/server/repository/event";
import { UserRepository } from "@calcom/lib/server/repository/user";
import slugify from "@calcom/lib/slugify";
import prisma from "@calcom/prisma";
import { BookingStatus, RedirectType } from "@calcom/prisma/client";

import { getTemporaryOrgRedirect } from "@lib/getTemporaryOrgRedirect";

import { getUsersInOrgContext } from "@server/lib/[user]/getServerSideProps";

type Props = {
  eventData: NonNullable<Awaited<ReturnType<typeof getPublicEvent>>>;
  booking?: GetBookingType;
  rescheduleUid: string | null;
  bookingUid: string | null;
  user: string;
  slug: string;
  isBrandingHidden: boolean;
  isSEOIndexable: boolean | null;
  themeBasis: null | string;
  orgBannerUrl: null;
};

async function processReschedule({
  props,
  rescheduleUid,
  session,
  allowRescheduleForCancelledBooking,
}: {
  props: Props;
  session: Session | null;
  rescheduleUid: string | string[] | undefined;
  allowRescheduleForCancelledBooking?: boolean;
}) {
  if (!rescheduleUid) return;

  const booking = await getBookingForReschedule(`${rescheduleUid}`, session?.user?.id);

  if (booking?.eventType?.disableRescheduling) {
    return {
      redirect: {
        destination: `/booking/${rescheduleUid}`,
        permanent: false,
      },
    };
  }

  // if no booking found, no eventTypeId (dynamic) or it matches this eventData - return void (success).
  if (
    booking === null ||
    !booking.eventTypeId ||
    (booking?.eventTypeId === props.eventData?.id &&
      (booking.status !== BookingStatus.CANCELLED ||
        allowRescheduleForCancelledBooking ||
        !!(props.eventData as any)?.allowReschedulingCancelledBookings))
  ) {
    props.booking = booking;
    props.rescheduleUid = Array.isArray(rescheduleUid) ? rescheduleUid[0] : rescheduleUid;
    return;
  }
  // handle redirect response
  const redirectEventTypeTarget = await prisma.eventType.findUnique({
    where: {
      id: booking.eventTypeId,
    },
    select: {
      slug: true,
    },
  });
  if (!redirectEventTypeTarget) {
    return {
      notFound: true,
    } as const;
  }
  return {
    redirect: {
      permanent: false,
      destination: redirectEventTypeTarget.slug,
    },
  };
}

async function processSeatedEvent({
  props,
  bookingUid,
  allowRescheduleForCancelledBooking,
}: {
  props: Props;
  bookingUid: string | string[] | undefined;
  allowRescheduleForCancelledBooking?: boolean;
}) {
  if (!bookingUid) return;
  const booking = await getBookingForSeatedEvent(`${bookingUid}`);
  if (booking?.status === BookingStatus.CANCELLED && !allowRescheduleForCancelledBooking) {
    return {
      redirect: {
        permanent: false,
        destination: `${props.slug}`,
      },
    };
  } else {
    props.booking = booking;
    props.bookingUid = Array.isArray(bookingUid) ? bookingUid[0] : bookingUid;
  }
}

async function getDynamicGroupPageProps(context: GetServerSidePropsContext) {
  const session = await getServerSession({ req: context.req });
  const { user: usernames, type: slug } = paramsSchema.parse(context.params);
  const { rescheduleUid, bookingUid } = context.query;
  const allowRescheduleForCancelledBooking = context.query.allowRescheduleForCancelledBooking === "true";
  const { currentOrgDomain, isValidOrgDomain } = orgDomainConfig(context.req, context.params?.orgSlug);
  const org = isValidOrgDomain ? currentOrgDomain : null;
  if (!org) {
    const redirect = await getTemporaryOrgRedirect({
      slugs: usernames,
      redirectType: RedirectType.User,
      eventTypeSlug: slug,
      currentQuery: context.query,
    });

    if (redirect) {
      return redirect;
    }
  }

  const userRepo = new UserRepository(prisma);
  const usersInOrgContext = await userRepo.findUsersByUsername({
    usernameList: usernames,
    orgSlug: isValidOrgDomain ? currentOrgDomain : null,
  });

  const users = usersInOrgContext;

  if (!users.length) {
    return {
      notFound: true,
    } as const;
  }

  // We use this to both prefetch the query on the server,
  // as well as to check if the event exist, so we c an show a 404 otherwise.

  const eventData = await EventRepository.getPublicEvent(
    {
      username: usernames.join("+"),
      eventSlug: slug,
      org,
      fromRedirectOfNonOrgLink: context.query.orgRedirection === "true",
    },
    session?.user?.id
  );

  if (!eventData) {
    return {
      notFound: true,
    } as const;
  }

  const props: Props = {
    eventData: {
      ...eventData,
      metadata: {
        ...eventData.metadata,
        multipleDuration: [15, 30, 45, 60, 90],
      },
    },
    user: usernames.join("+"),
    slug,
    isBrandingHidden: false,
    isSEOIndexable: true,
    themeBasis: null,
    bookingUid: bookingUid ? `${bookingUid}` : null,
    rescheduleUid: null,
    orgBannerUrl: null,
  };

  if (rescheduleUid) {
    const processRescheduleResult = await processReschedule({
      props,
      rescheduleUid,
      session,
      allowRescheduleForCancelledBooking,
    });
    if (processRescheduleResult) {
      return processRescheduleResult;
    }
  } else if (bookingUid) {
    const processSeatResult = await processSeatedEvent({
      props,
      bookingUid,
      allowRescheduleForCancelledBooking,
    });
    if (processSeatResult) {
      return processSeatResult;
    }
  }

  return {
    props,
  };
}

async function getUserPageProps(context: GetServerSidePropsContext) {
  const session = await getServerSession({ req: context.req });
  const { user: usernames, type: slug } = paramsSchema.parse(context.params);
  const username = usernames[0];
  const { rescheduleUid, bookingUid } = context.query;
  const allowRescheduleForCancelledBooking = context.query.allowRescheduleForCancelledBooking === "true";
  const { currentOrgDomain, isValidOrgDomain } = orgDomainConfig(context.req, context.params?.orgSlug);

  const isOrgContext = currentOrgDomain && isValidOrgDomain;
  if (!isOrgContext) {
    const redirect = await getTemporaryOrgRedirect({
      slugs: usernames,
      redirectType: RedirectType.User,
      eventTypeSlug: slug,
      currentQuery: context.query,
    });

    if (redirect) {
      return redirect;
    }
  }

  const [user] = await getUsersInOrgContext([username], isValidOrgDomain ? currentOrgDomain : null);

  if (!user) {
    return {
      notFound: true,
    } as const;
  }

  const org = isValidOrgDomain ? currentOrgDomain : null;

  // We use this to both prefetch the query on the server,
  // as well as to check if the event exist, so we can show a 404 otherwise.
  const eventData = await EventRepository.getPublicEvent(
    {
      username,
      eventSlug: slug,
      org,
      fromRedirectOfNonOrgLink: context.query.orgRedirection === "true",
    },
    session?.user?.id
  );

  if (!eventData) {
    return {
      notFound: true,
    } as const;
  }

  const allowSEOIndexing = org
    ? user?.profile?.organization?.organizationSettings?.allowSEOIndexing
      ? user?.allowSEOIndexing
      : false
    : user?.allowSEOIndexing;

  const props: Props = {
    eventData: eventData,
    user: username,
    slug,
    isBrandingHidden: shouldHideBrandingForUserEvent({
      eventTypeId: eventData.id,
      owner: user,
    }),
    isSEOIndexable: allowSEOIndexing,
    themeBasis: username,
    bookingUid: bookingUid ? `${bookingUid}` : null,
    rescheduleUid: null,
    orgBannerUrl: eventData?.owner?.profile?.organization?.bannerUrl ?? null,
  };
  if (rescheduleUid) {
    const processRescheduleResult = await processReschedule({
      props,
      rescheduleUid,
      session,
      allowRescheduleForCancelledBooking,
    });
    if (processRescheduleResult) {
      return processRescheduleResult;
    }
  } else if (bookingUid) {
    const processSeatResult = await processSeatedEvent({
      props,
      bookingUid,
      allowRescheduleForCancelledBooking,
    });
    if (processSeatResult) {
      return processSeatResult;
    }
  }

  return {
    props,
  };
}

const paramsSchema = z.object({
  type: z.string().transform((s) => slugify(s)),
  user: z.string().transform((s) => getUsernameList(s)),
});

// Booker page fetches a tiny bit of data server side, to determine early
// whether the page should show an away state or dynamic booking not allowed.
export const getServerSideProps = async (context: GetServerSidePropsContext) => {
  const { user } = paramsSchema.parse(context.params);
  const isDynamicGroup = user.length > 1;

  return isDynamicGroup ? await getDynamicGroupPageProps(context) : await getUserPageProps(context);
};
