import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Development test users
const users = [
  { googleId: "dev-user-1", email: "dev@example.com", picture: null },
  { googleId: "dev-user-2", email: "test@example.com", picture: null },
];

// Development test devices (will be linked to users after creation)
const devices = [
  { id: "JK00000000AA", name: "Office JetKVM" },
  { id: "JK00000000BB", name: "Home Lab Server" },
  { id: "JK00000000CC", name: "Datacenter Rack 1" },
];

// Sample TURN activity data
const turnActivities = [
  { bytesSent: 102400, bytesReceived: 204800 },
  { bytesSent: 51200, bytesReceived: 76800 },
  { bytesSent: 256000, bytesReceived: 512000 },
];

// Production release snapshot
const releases = [
  { version: "0.2.6", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.2.6/jetkvm_app", hash: "4b121195aa9dae9bd4ae7d1e69f49383510f9552cd9a9edd1a9f92c71e128f9c", createdAt: new Date("2024-09-27T11:41:59.669Z") },
  { version: "0.2.7", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.2.7/jetkvm_app", hash: "2dbcc5a7bc1cc7196b458e633f654b521351eda66764b7a6d6a04f60a17347ca", createdAt: new Date("2024-09-27T11:59:32.279Z") },
  { version: "0.1.7", type: "system", rolloutPercentage: 100, url: "https://update.jetkvm.com/system/0.1.7/system.tar", hash: "194287cf911801852cdc57aa9e8c9cfa59bf6c27feb5ae260f35bcfa895789e3", createdAt: new Date("2024-10-01T20:00:03.780Z") },
  { version: "0.1.1", type: "system", rolloutPercentage: 100, url: "https://update.jetkvm.com/system/0.1.1/system.tar", hash: "5a05c1e052e1bc47a5e977a7b7b489712ad44c594b552bba258dfd22aca1ad9a", createdAt: new Date("2024-09-24T12:58:47.937Z") },
  { version: "0.1.8", type: "system", rolloutPercentage: 100, url: "https://update.jetkvm.com/system/0.1.8/system.tar", hash: "bed3d65d1b42523df13589e437dc13518f9bd01f7a931239b57229e7363f8bf6", createdAt: new Date("2024-10-02T14:33:25.440Z") },
  { version: "0.1.2", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.1.2/jetkvm_app", hash: "862ccb948e5c502d105df7e09b3bfc52ad8315da9604ff06ae8c656c22122c0b", createdAt: new Date("2024-09-24T22:00:32.746Z") },
  { version: "0.1.2", type: "system", rolloutPercentage: 100, url: "https://update.jetkvm.com/system/0.1.2/system.tar", hash: "e4837bb69bad171f344ce4c217dae2f336eb2061ef5925bcde1a422662fce746", createdAt: new Date("2024-09-24T22:14:31.697Z") },
  { version: "0.1.5", type: "system", rolloutPercentage: 100, url: "https://update.jetkvm.com/system/0.1.5/system.tar", hash: "e91909baaaf3cbf7efa2c3e8a137583434815358ec154d610a00259e74fea15b", createdAt: new Date("2024-09-25T08:33:51.864Z") },
  { version: "0.2.0", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.2.0/jetkvm_app", hash: "d6dbb285cea3c65793e22b078892f9cc9727589f4e6b9d61c53297a046f84cd9", createdAt: new Date("2024-09-26T11:56:23.269Z") },
  { version: "0.2.1", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.2.1/jetkvm_app", hash: "7101702e624db17353c38326f9b68c084861117939f695d3975da9c1f11937af", createdAt: new Date("2024-09-26T21:17:39.490Z") },
  { version: "0.2.2", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.2.2/jetkvm_app", hash: "565c208ea38de7c5159b0ee48f749342dff199f2cf5f8920e2a57cddaf203b98", createdAt: new Date("2024-09-27T11:20:42.187Z") },
  { version: "0.2.4", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.2.4/jetkvm_app", hash: "6194d26cf6561f5ff100449543c8dafae97670d646e8341dfa6b5c2e5dc74046", createdAt: new Date("2024-09-27T11:35:54.197Z") },
  { version: "0.2.5", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.2.5/jetkvm_app", hash: "7c04c92376215a960aaf83c85676be34e8092141703c3e81b7803b489e24aeb7", createdAt: new Date("2024-09-27T11:38:53.232Z") },
  { version: "0.1.6", type: "system", rolloutPercentage: 100, url: "https://update.jetkvm.com/system/0.1.6/system.tar", hash: "452219f93506330603d7c9d064d69bfbe2e9d4a5d423c30cfa2bbbb9abd38646", createdAt: new Date("2024-09-26T14:01:46.204Z") },
  { version: "0.1.3", type: "system", rolloutPercentage: 100, url: "https://update.jetkvm.com/system/0.1.3/system.tar", hash: "d72be7e827c4ff963b5552976f067c2c46b82ac8808164361dd96410afd0486b", createdAt: new Date("2024-09-24T22:55:50.602Z") },
  { version: "0.1.5", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.1.5/jetkvm_app", hash: "a97171ef802db6546fd920b9e04742822426f9ec17dd499cf2183c87c449cc99", createdAt: new Date("2024-09-24T23:08:01.309Z") },
  { version: "0.1.6", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.1.6/jetkvm_app", hash: "1bb5f26ce5d101a7a81ce03a50e818bd1ab72c749decc7b415218ae875127903", createdAt: new Date("2024-09-24T23:16:19.772Z") },
  { version: "0.1.4", type: "system", rolloutPercentage: 100, url: "https://update.jetkvm.com/system/0.1.4/system.tar", hash: "47b66d5e6033a4b1397633e7eb0987498b946f0b57569e6ae013f748f0589a5f", createdAt: new Date("2024-09-24T23:08:01.434Z") },
  { version: "0.1.9", type: "system", rolloutPercentage: 100, url: "https://update.jetkvm.com/system/0.1.9/system.tar", hash: "55d16d21ad240c321dbbb5c96499180b0b1edb48dead5df563467476f6224498", createdAt: new Date("2024-10-03T21:14:07.212Z") },
  { version: "0.2.8", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.2.8/jetkvm_app", hash: "181ff6b2d1e5a9dbb8af8e339c138caf37f568e64ebcf1d00b72374d046c63f1", createdAt: new Date("2024-10-05T09:52:32.306Z") },
  { version: "0.2.10", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.2.10/jetkvm_app", hash: "26b671563fc0c6fafb927f5c8791a1e16cf9bb0735a8c66adc4fe3dd092c30bd", createdAt: new Date("2024-10-09T13:58:23.694Z") },
  { version: "0.2.9", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.2.9/jetkvm_app", hash: "b556e8d83b08f5340d324e8cd559545871a6bea045b06e1c65087850f678aca4", createdAt: new Date("2024-10-08T22:29:26.768Z") },
  { version: "0.2.11", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.2.11/jetkvm_app", hash: "9f899a26844bf118a2c13828bf38a1261801d30e7c441440e15300ac85ec42e1", createdAt: new Date("2024-10-09T14:58:29.230Z") },
  { version: "0.2.13", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.2.13/jetkvm_app", hash: "4e539e27c211602371f643583e57a045d5dea76c6a79ea2cfdcf17df1e1f11a1", createdAt: new Date("2024-10-09T17:15:24.008Z") },
  { version: "0.1.10", type: "system", rolloutPercentage: 100, url: "https://update.jetkvm.com/system/0.1.10/system.tar", hash: "8f22840726b6451312154fc12f8f2a3fe9fd0700b4204691d1a98be0c37598f9", createdAt: new Date("2024-10-09T15:08:38.644Z") },
  { version: "0.2.12", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.2.12/jetkvm_app", hash: "64b8a040115ab8a5cc7bd5cdb719d383478dbcc7dad86ef0742e553b71f0dcd3", createdAt: new Date("2024-10-09T15:08:38.546Z") },
  { version: "0.2.14", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.2.14/jetkvm_app", hash: "67f63fa8afa9c9b216e47c2c61ec7bfee2b22d9947d84751ee2d7e7562ec23d2", createdAt: new Date("2024-10-09T19:29:31.237Z") },
  { version: "0.2.15", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.2.15/jetkvm_app", hash: "345e23ae2a3261dd342de62a61e89257e9ac9b42bc36145bece9d3ec95676be4", createdAt: new Date("2024-10-09T20:20:35.403Z") },
  { version: "0.1.13", type: "system", rolloutPercentage: 100, url: "https://update.jetkvm.com/system/0.1.13/system.tar", hash: "75b1a45c2d74143b5b1bed81413aa08131630eba807a98ac0c3d9694721e2d19", createdAt: new Date("2024-10-09T20:07:07.184Z") },
  { version: "0.1.11", type: "system", rolloutPercentage: 100, url: "https://update.jetkvm.com/system/0.1.11/system.tar", hash: "8a6670fea5f71bc3eb4c11adace93b0d6dcb43749470ba4d108d6d9bdab2f361", createdAt: new Date("2024-10-09T19:51:35.340Z") },
  { version: "0.1.14", type: "system", rolloutPercentage: 100, url: "https://update.jetkvm.com/system/0.1.14/system.tar", hash: "39bfd1ade8fa600ae3f2bd53edacc71e67a09e26b647271362072eaa9d6fcefc", createdAt: new Date("2024-10-09T20:32:55.169Z") },
  { version: "0.3.0", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.3.0/jetkvm_app", hash: "60178f09efa19b47258dbdf21d6a1cd16787318ca7ea40d227400ac2adad7a9f", createdAt: new Date("2024-10-17T21:16:52.594Z") },
  { version: "0.1.16", type: "system", rolloutPercentage: 100, url: "https://update.jetkvm.com/system/0.1.16/system.tar", hash: "e66f03743166919f2fd7b381f29a0aa0b1f069be94810da8da91efd2dc18d24a", createdAt: new Date("2024-10-17T21:20:36.615Z") },
  { version: "0.1.17", type: "system", rolloutPercentage: 100, url: "https://update.jetkvm.com/system/0.1.17/system.tar", hash: "deff8da13e4ba07518293b7cc141da4251d8ee9fc4e56aebeb070302231793ac", createdAt: new Date("2024-10-20T20:08:47.286Z") },
  { version: "0.3.1", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.3.1/jetkvm_app", hash: "7c1ca0c0172f24108d36d5abea6832cd1afff5f14346e6b37d0cde98740ecc03", createdAt: new Date("2024-10-20T20:08:47.272Z") },
  { version: "0.3.3", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.3.3/jetkvm_app", hash: "c5b259fd175214120c39ab1537048f206a24aee735bb9cf2014e706eab76a18a", createdAt: new Date("2024-10-20T21:50:29.881Z") },
  { version: "0.3.2", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.3.2/jetkvm_app", hash: "3f9d2ee78ec3982e1453af32fb427cd7f295c63f41fecd67203c837dbf082bd1", createdAt: new Date("2024-10-20T21:48:53.502Z") },
  { version: "0.1.15", type: "system", rolloutPercentage: 100, url: "https://update.jetkvm.com/system/0.1.15/system.tar", hash: "628090f5ec23180e777071462c7ddde2f3877a61c843492842742d0fff3f248c", createdAt: new Date("2024-10-14T12:19:16.214Z") },
  { version: "0.2.16", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.2.16/jetkvm_app", hash: "883b9f3fc78105a2f67ad1607a097e9b5438af809c7fe573870c66b64120d69c", createdAt: new Date("2024-10-14T12:19:16.204Z") },
  { version: "0.3.4", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.3.4/jetkvm_app", hash: "4424ce7ce846433c17201d46f250c7bc3a43d922f3a66b85f39fb752b443bdfd", createdAt: new Date("2024-10-23T20:22:38.094Z") },
  { version: "0.1.18", type: "system", rolloutPercentage: 100, url: "https://update.jetkvm.com/system/0.1.18/system.tar", hash: "96200b22791098eb486268367eb3fa1f290eefa2a134f4ec6f340b0b46fef144", createdAt: new Date("2024-10-29T09:04:39.679Z") },
  { version: "0.2.0", type: "system", rolloutPercentage: 100, url: "https://update.jetkvm.com/system/0.2.0/system.tar", hash: "d837334a6ca38e37e6ea3d57b611047a73d9244ce62b931ab4d39315de71dfb3", createdAt: new Date("2024-12-17T23:52:12.111Z") },
  { version: "0.2.2", type: "system", rolloutPercentage: 100, url: "https://update.jetkvm.com/system/0.2.2/system.tar", hash: "c8ca720302afe24e87e0e9b414618ef697125f1d56e6b363a20149327896cbd8", createdAt: new Date("2025-02-18T17:48:19.615Z") },
  { version: "0.3.6", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.3.6/jetkvm_app", hash: "04f46d00525666d38faf4b56e6c30ddbd92c1da13e22ef5eec05d1650ebe3e64", createdAt: new Date("2025-02-18T17:34:05.473Z") },
  { version: "0.3.7", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.3.7/jetkvm_app", hash: "c6a994a20475cfc6f12a22e7e97a82d3c3d49c3c77586a7c37efd71b22b2a061", createdAt: new Date("2025-02-19T09:37:59.621Z") },
  { version: "0.2.3", type: "system", rolloutPercentage: 100, url: "https://update.jetkvm.com/system/0.2.3/system.tar", hash: "6a4c0bae97d9514af44be75fc3568ec3207f0c6ea16849232c4990169690f5df", createdAt: new Date("2025-02-24T20:50:45.339Z") },
  { version: "0.4.6", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.4.6/jetkvm_app", hash: "05c6930cc1202196515f3aef06b94add7207e13d0b5e09da05dc5302ed5a0650", createdAt: new Date("2025-07-03T17:14:59.031Z") },
  { version: "0.3.8", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.3.8/jetkvm_app", hash: "48be0a2ebce85f73ee2962da4aebb7ce90619317402e67879127786e3fe84a91", createdAt: new Date("2025-03-19T17:35:01.683Z") },
  { version: "0.4.1", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.4.1/jetkvm_app", hash: "c8bacbbda56bedaa99babaf19844fb77d97a9083f3b61888b7b32991b78f1f0a", createdAt: new Date("2025-05-22T09:24:07.099Z") },
  { version: "0.3.9", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.3.9/jetkvm_app", hash: "87992294b53062bebc666734d6df7de5ca9fd9867744f94f59e481ff03b7f777", createdAt: new Date("2025-04-10T15:21:31.628Z") },
  { version: "0.2.5", type: "system", rolloutPercentage: 100, url: "https://update.jetkvm.com/system/0.2.5/system.tar", hash: "2323463ea8652be767d94514e548f90dd61b1ebcc0fb1834d700fac5b3d88a35", createdAt: new Date("2025-06-25T13:12:05.875Z") },
  { version: "0.2.4", type: "system", rolloutPercentage: 100, url: "https://update.jetkvm.com/system/0.2.4/system.tar", hash: "086370c43f0c6e76714a2fa2b98c277a32d712e6cce7c15f36ed4e5011b7e12f", createdAt: new Date("2025-05-03T13:05:00.863Z") },
  { version: "0.4.3", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.4.3/jetkvm_app", hash: "86ccb9465ddc440ba2b4d19f6468507eaa4aec3ecf824e2d48d47f9e4b9e742c", createdAt: new Date("2025-06-12T12:27:59.748Z") },
  { version: "0.4.4", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.4.4/jetkvm_app", hash: "7c08330d97d85d195227de47a522eb8764191b6e2949aecefdcd45760c248a2c", createdAt: new Date("2025-06-12T23:10:21.905Z") },
  { version: "0.4.5", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.4.5/jetkvm_app", hash: "8f7b3d5451da972bf9bc201df2333176bbc7e7abedb437eeb77c1793bc97bf5f", createdAt: new Date("2025-06-25T11:32:06.803Z") },
  { version: "0.4.8", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.4.8/jetkvm_app", hash: "714f33432f17035e38d238bf376e98f3073e6cc2845d269ff617503d12d92bdd", createdAt: new Date("2025-09-22T10:51:47.172Z") },
  { version: "0.2.7", type: "system", rolloutPercentage: 100, url: "https://update.jetkvm.com/system/0.2.7/system.tar", hash: "da62bc0246d84e575c719a076a8f403e16e492192e178ecd68bc04ada853f557", createdAt: new Date("2025-10-21T15:24:27.494Z") },
  { version: "0.5.1", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.5.1/jetkvm_app", hash: "38be7445fea495d51c50100f5e371677e0cee491e97a2375ec3ccbac499774ad", createdAt: new Date("2025-12-22T11:06:22.284Z") },
  { version: "0.4.9", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.4.9/jetkvm_app", hash: "220db72f14a0661d5d62aaafbe47089c706f2562649ec4e794511906d499d568", createdAt: new Date("2025-10-21T14:50:28.122Z") },
  { version: "0.5.0", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.5.0/jetkvm_app", hash: "6230970da08c97f25205a57554ec6376f05f9f065cb9252c70ac2b13f981da9e", createdAt: new Date("2025-12-08T14:04:07.373Z") },
  { version: "0.5.2", type: "app", rolloutPercentage: 100, url: "https://update.jetkvm.com/app/0.5.2/jetkvm_app", hash: "a3a0d26c26a4972503f51a0b039944755d825be0bfc7514e71d2b908a1e2aa00", createdAt: new Date("2026-01-07T18:14:13.655Z") },
];

async function seedUsers(): Promise<bigint[]> {
  const count = await prisma.user.count();
  if (count > 0) {
    console.log(`[seed] User: skipped (${count} records exist)`);
    const existing = await prisma.user.findMany({ select: { id: true } });
    return existing.map((u) => u.id);
  }

  // Create users individually to get their IDs back (createMany doesn't return IDs)
  const createdIds: bigint[] = [];
  for (const user of users) {
    const created = await prisma.user.create({ data: user });
    createdIds.push(created.id);
  }
  console.log(`[seed] User: created ${createdIds.length} records`);
  return createdIds;
}

async function seedDevices(userIds: bigint[]): Promise<void> {
  const count = await prisma.device.count();
  if (count > 0) {
    console.log(`[seed] Device: skipped (${count} records exist)`);
    return;
  }

  if (userIds.length === 0) {
    console.log(`[seed] Device: skipped (no users to link)`);
    return;
  }

  const devicesWithUsers = devices.map((device, index) => ({
    ...device,
    userId: userIds[index % userIds.length],
  }));

  await prisma.device.createMany({ data: devicesWithUsers });
  console.log(`[seed] Device: created ${devicesWithUsers.length} records`);
}

async function seedTurnActivity(userIds: bigint[]): Promise<void> {
  const count = await prisma.turnActivity.count();
  if (count > 0) {
    console.log(`[seed] TurnActivity: skipped (${count} records exist)`);
    return;
  }

  if (userIds.length === 0) {
    console.log(`[seed] TurnActivity: skipped (no users to link)`);
    return;
  }

  const activitiesWithUsers = turnActivities.map((activity, index) => ({
    ...activity,
    userId: userIds[index % userIds.length],
  }));

  await prisma.turnActivity.createMany({ data: activitiesWithUsers });
  console.log(`[seed] TurnActivity: created ${activitiesWithUsers.length} records`);
}

async function seedReleases(): Promise<void> {
  const count = await prisma.release.count();
  if (count > 0) {
    console.log(`[seed] Release: skipped (${count} records exist)`);
    return;
  }

  await prisma.release.createMany({ data: releases });
  console.log(`[seed] Release: created ${releases.length} records`);
}

async function main() {
  console.log("[seed] Starting database seed...");

  // Seed in order respecting foreign key constraints
  const userIds = await seedUsers();
  await seedDevices(userIds);
  await seedTurnActivity(userIds);
  await seedReleases();

  console.log("[seed] Database seed completed.");
}

main()
  .catch((e) => {
    console.error("[seed] Error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
