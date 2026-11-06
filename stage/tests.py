from django.core.files.uploadedfile import SimpleUploadedFile
import json
from django.test import TestCase, Client, RequestFactory
from django.urls import reverse
from django.contrib.auth.models import User, Permission
from django.contrib.admin.sites import AdminSite
from .models import SongProject, Section, Measure
from .admin import SongProjectAdmin

class SyncStageTests(TestCase):
    def setUp(self):
        self.client = Client()

    def test_root_studio_view_clean_state(self):
        resp = self.client.get(reverse('studio'))
        self.assertEqual(resp.status_code, 200)
        self.assertContains(resp, 'initial-project-data')
        self.assertContains(resp, 'UNTITLED PROJECT')

    def test_save_and_load_timing_points(self):
        save_payload = {
            "title": "ABBA WORSHIP",
            "key": "E",
            "bpm": 135.0,
            "totalMeasures": 32,
            "beatsPerBar": 4,
            "timingPoints": [
                {"id": 1, "offset": 0.852, "bpm": 135.0, "beatsPerBar": 4},
                {"id": 2, "offset": 45.120, "bpm": 135.0, "beatsPerBar": 4}
            ],
            "sections": [
                {"startBar": 1, "name": "Intro", "color": "#facc15", "isNewSong": True, "songTitle": "ABBA WORSHIP", "songKey": "E"}
            ],
            "measures": [
                {"bar": 1, "chordLine": "E . B .", "leadLine": ""}
            ]
        }

        # 1. Save new project via API
        save_resp = self.client.post(
            reverse('api_save_new'),
            data=json.dumps(save_payload),
            content_type='application/json'
        )
        self.assertEqual(save_resp.status_code, 200)
        project_id = save_resp.json()['projectId']

        # 2. Check timing points in DB
        project = SongProject.objects.get(id=project_id)
        self.assertEqual(len(project.timing_points), 2)
        self.assertEqual(project.timing_points[0]['offset'], 0.852)

        # 3. Check studio_view redirects legacy ID to slug, and slug renders exact timing points
        view_resp = self.client.get(reverse('studio_project', kwargs={'project_id': project_id}), follow=True)
        self.assertEqual(view_resp.status_code, 200)
        self.assertContains(view_resp, '0.852')

        slug_resp = self.client.get(reverse('studio_slug', kwargs={'slug': project.slug}))
        self.assertEqual(slug_resp.status_code, 200)
        self.assertContains(slug_resp, '0.852')

        # 4. Check load_project_api returns timing points
        api_load_resp = self.client.get(reverse('api_load_project', kwargs={'project_id': project_id}))
        self.assertEqual(api_load_resp.status_code, 200)
        loaded_data = api_load_resp.json()
        self.assertEqual(len(loaded_data['project']['timingPoints']), 2)
        self.assertEqual(loaded_data['project']['timingPoints'][0]['offset'], 0.852)

    def test_delete_project(self):
        project = SongProject.objects.create(title="Delete Me", bpm=120)
        del_resp = self.client.post(
            reverse('api_delete_project', kwargs={'project_id': project.id}),
            HTTP_X_REQUESTED_WITH='XMLHttpRequest'
        )
        self.assertEqual(del_resp.status_code, 200)
        self.assertEqual(del_resp.json()['status'], 'deleted')
        self.assertFalse(SongProject.objects.filter(id=project.id).exists())

    def test_new_project_rendered_and_top_bar_delete_removed(self):
        resp = self.client.get(reverse('studio'))
        self.assertEqual(resp.status_code, 200)
        # Verify New Project button and audio load input exist
        self.assertContains(resp, 'id="btn-new-project"')
        self.assertContains(resp, 'id="audio-file-input"')
        self.assertContains(resp, 'id="new-project-modal"')
        self.assertContains(resp, 'Start New Project')
        self.assertContains(resp, 'id="btn-cancel-new-project"')
        self.assertContains(resp, 'id="btn-discard-new-project"')
        self.assertContains(resp, 'id="btn-save-new-project"')
        # Ensure delete button in top bar has been removed
        self.assertNotContains(resp, 'id="btn-clear-audio"')

    def test_save_project_with_audio_file(self):
        audio_file = SimpleUploadedFile("track.mp3", b"RIFF dummy mp3 audio content", content_type="audio/mpeg")
        payload = {
            "title": "AUDIO SONG",
            "key": "A",
            "bpm": 128.0,
            "totalMeasures": 16,
            "timingPoints": [
                {"id": 1, "offset": 0.0, "bpm": 128.0, "beatsPerBar": 4}
            ],
            "sections": [
                {"startBar": 1, "name": "Verse 1", "color": "#facc15", "isNewSong": True, "songTitle": "AUDIO SONG", "songKey": "A"}
            ],
            "measures": [
                {"bar": 1, "chordLine": "A . . .", "leadLine": ""}
            ]
        }

        save_resp = self.client.post(
            reverse('api_save_new'),
            data={
                'project_data': json.dumps(payload),
                'audio_file': audio_file
            }
        )
        self.assertEqual(save_resp.status_code, 200)
        resp_data = save_resp.json()
        self.assertEqual(resp_data['status'], 'saved')
        self.assertTrue(resp_data.get('audioUrl'))
        self.assertIn('track', resp_data['audioUrl'])

        project_id = resp_data['projectId']
        project = SongProject.objects.get(id=project_id)
        self.assertTrue(project.audio_file)
        self.assertIn('track', project.audio_file.name)

        # Check studio view exposes audioUrl in initial_project_data
        view_resp = self.client.get(reverse('studio_project', kwargs={'project_id': project_id}), follow=True)
        self.assertEqual(view_resp.status_code, 200)
        self.assertContains(view_resp, project.audio_file.url)

        slug_resp = self.client.get(reverse('studio_slug', kwargs={'slug': project.slug}))
        self.assertEqual(slug_resp.status_code, 200)
        self.assertContains(slug_resp, project.audio_file.url)

        # Check load API returns audioUrl
        load_resp = self.client.get(reverse('api_load_project', kwargs={'project_id': project_id}))
        self.assertEqual(load_resp.status_code, 200)
        self.assertEqual(load_resp.json()['project']['audioUrl'], project.audio_file.url)

        # Clean up uploaded file
        if project.audio_file:
            project.audio_file.delete(save=False)

    def test_upload_audio_api(self):
        project = SongProject.objects.create(title="Upload API Test", bpm=120)
        audio_file = SimpleUploadedFile("direct_upload.mp3", b"dummy audio file data", content_type="audio/mpeg")

        resp = self.client.post(
            reverse('api_upload_audio', kwargs={'project_id': project.id}),
            data={'audio_file': audio_file}
        )
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data['status'], 'uploaded')
        self.assertTrue(data.get('audioUrl'))

        project.refresh_from_db()
        self.assertTrue(project.audio_file)
        self.assertIn('direct_upload', project.audio_file.name)

        # Clean up
        if project.audio_file:
            project.audio_file.delete(save=False)

    def test_slug_generation_and_redirect(self):
        # 1. Create a project
        p1 = SongProject.objects.create(title="My Awesome Song", bpm=120)
        self.assertEqual(p1.slug, "my-awesome-song")

        # 2. Accessing by numeric ID redirects (302) to slug URL
        id_resp = self.client.get(f"/{p1.id}/")
        self.assertEqual(id_resp.status_code, 302)
        self.assertEqual(id_resp.url, f"/{p1.slug}/")

        # 3. Accessing by slug URL renders directly (200)
        slug_resp = self.client.get(f"/{p1.slug}/")
        self.assertEqual(slug_resp.status_code, 200)
        self.assertContains(slug_resp, "My Awesome Song")
        self.assertContains(slug_resp, '"projectSlug": "my-awesome-song"')

        # 4. Duplicate title generates unique suffix
        p2 = SongProject.objects.create(title="My Awesome Song", bpm=120)
        self.assertEqual(p2.slug, "my-awesome-song-2")

        # 5. Purely numeric titles get prefixed with 'song-'
        p3 = SongProject.objects.create(title="1999", bpm=120)
        self.assertEqual(p3.slug, "song-1999")

        # 6. Renaming updates slug via save API
        save_resp = self.client.post(
            reverse('api_save_existing_slug', kwargs={'slug': p1.slug}),
            data=json.dumps({"title": "Renamed Track", "totalMeasures": 8}),
            content_type='application/json'
        )
        self.assertEqual(save_resp.status_code, 200)
        resp_json = save_resp.json()
        self.assertEqual(resp_json['slug'], 'renamed-track')
        p1.refresh_from_db()
        self.assertEqual(p1.slug, 'renamed-track')

    def test_delete_project_pin_protection(self):
        project = SongProject.objects.create(title="Protected Song", bpm=120, edit_pin="5555")

        # 1. Attempt delete without PIN -> 403 Forbidden
        del_no_pin = self.client.post(
            reverse('api_delete_project', kwargs={'project_id': project.id}),
            HTTP_X_REQUESTED_WITH='XMLHttpRequest'
        )
        self.assertEqual(del_no_pin.status_code, 403)
        self.assertEqual(del_no_pin.json()['status'], 'locked')
        self.assertTrue(SongProject.objects.filter(id=project.id).exists())

        # 2. Attempt delete with wrong PIN -> 403 Forbidden
        del_wrong_pin = self.client.post(
            reverse('api_delete_project', kwargs={'project_id': project.id}),
            data=json.dumps({'pin': '9999'}),
            content_type='application/json',
            HTTP_X_REQUESTED_WITH='XMLHttpRequest'
        )
        self.assertEqual(del_wrong_pin.status_code, 403)
        self.assertEqual(del_wrong_pin.json()['status'], 'locked')
        self.assertTrue(SongProject.objects.filter(id=project.id).exists())

        # 3. Attempt delete with correct PIN -> 200 OK
        del_correct_pin = self.client.post(
            reverse('api_delete_project', kwargs={'project_id': project.id}),
            data=json.dumps({'pin': '5555'}),
            content_type='application/json',
            HTTP_X_REQUESTED_WITH='XMLHttpRequest'
        )
        self.assertEqual(del_correct_pin.status_code, 200)
        self.assertEqual(del_correct_pin.json()['status'], 'deleted')
        self.assertFalse(SongProject.objects.filter(id=project.id).exists())

    def test_studio_api_enforces_pin_even_for_logged_in_admin(self):
        admin_user = User.objects.create_superuser(username='admin', password='password123', email='admin@example.com')
        self.client.force_login(admin_user)

        project = SongProject.objects.create(title="Admin Pin Protection Test", bpm=120, edit_pin="secret123")

        # 1. Studio delete without PIN returns 403 even if superuser session is active
        del_resp = self.client.post(
            reverse('api_delete_project', kwargs={'project_id': project.id}),
            HTTP_X_REQUESTED_WITH='XMLHttpRequest'
        )
        self.assertEqual(del_resp.status_code, 403)
        self.assertEqual(del_resp.json()['status'], 'locked')
        self.assertTrue(SongProject.objects.filter(id=project.id).exists())

        # 2. Studio delete WITH correct PIN succeeds
        del_ok = self.client.post(
            reverse('api_delete_project', kwargs={'project_id': project.id}),
            data=json.dumps({'pin': 'secret123'}),
            content_type='application/json',
            HTTP_X_REQUESTED_WITH='XMLHttpRequest'
        )
        self.assertEqual(del_ok.status_code, 200)
        self.assertFalse(SongProject.objects.filter(id=project.id).exists())

    def test_admin_panel_delete_permission(self):
        factory = RequestFactory()
        admin_site = AdminSite()
        model_admin = SongProjectAdmin(SongProject, admin_site)

        # 1. Superuser has delete permission in admin panel and can delete without PIN
        superuser = User.objects.create_superuser(username='super', password='pass', email='super@example.com')
        req = factory.get('/admin/')
        req.user = superuser
        self.assertTrue(model_admin.has_delete_permission(req))

        project = SongProject.objects.create(title="Admin Panel Delete Test", bpm=120, edit_pin="pin999")
        model_admin.delete_model(req, project)
        self.assertFalse(SongProject.objects.filter(id=project.id).exists())

        # 2. Regular user without permissions does NOT have delete permission in admin panel
        reg_user = User.objects.create_user(username='regular', password='pass')
        req.user = reg_user
        self.assertFalse(model_admin.has_delete_permission(req))

        # 3. Staff user with explicit delete_songproject permission HAS delete permission
        staff_user = User.objects.create_user(username='staff', password='pass', is_staff=True)
        delete_perm = Permission.objects.get(codename='delete_songproject')
        staff_user.user_permissions.add(delete_perm)
        staff_user = User.objects.get(id=staff_user.id) # refresh
        req.user = staff_user
        self.assertTrue(model_admin.has_delete_permission(req))

    def test_save_project_pin_lifecycle(self):
        # 1. Create a project setting PIN
        save_new_resp = self.client.post(
            reverse('api_save_new'),
            data=json.dumps({
                "title": "PIN Protected Song",
                "key": "G",
                "setPin": "1234"
            }),
            content_type='application/json'
        )
        self.assertEqual(save_new_resp.status_code, 200)
        new_data = save_new_resp.json()
        self.assertTrue(new_data['isLocked'])
        project_id = new_data['projectId']

        project = SongProject.objects.get(id=project_id)
        self.assertEqual(project.edit_pin, "1234")

        # 2. Attempt update without PIN -> 403
        bad_save = self.client.post(
            reverse('api_save_existing', kwargs={'project_id': project_id}),
            data=json.dumps({"title": "Hacked Title"}),
            content_type='application/json'
        )
        self.assertEqual(bad_save.status_code, 403)
        self.assertEqual(bad_save.json()['status'], 'locked')

        # 3. Attempt update with wrong PIN -> 403
        wrong_pin_save = self.client.post(
            reverse('api_save_existing', kwargs={'project_id': project_id}),
            data=json.dumps({"title": "Hacked Title", "pin": "0000"}),
            content_type='application/json'
        )
        self.assertEqual(wrong_pin_save.status_code, 403)

        # 4. Update with correct PIN -> 200
        ok_save = self.client.post(
            reverse('api_save_existing', kwargs={'project_id': project_id}),
            data=json.dumps({"title": "Legit Title", "pin": "1234"}),
            content_type='application/json'
        )
        self.assertEqual(ok_save.status_code, 200)
        self.assertTrue(ok_save.json()['isLocked'])
        project.refresh_from_db()
        self.assertEqual(project.title, "LEGIT TITLE")

        # 5. Change PIN to 5678 (provide old pin in 'pin', new in 'setPin')
        change_pin_save = self.client.post(
            reverse('api_save_existing', kwargs={'project_id': project_id}),
            data=json.dumps({"title": "Legit Title", "pin": "1234", "setPin": "5678"}),
            content_type='application/json'
        )
        self.assertEqual(change_pin_save.status_code, 200)
        project.refresh_from_db()
        self.assertEqual(project.edit_pin, "5678")

        # 6. Clear PIN (provide current pin in 'pin', setPin='')
        clear_pin_save = self.client.post(
            reverse('api_save_existing', kwargs={'project_id': project_id}),
            data=json.dumps({"title": "Legit Title", "pin": "5678", "setPin": ""}),
            content_type='application/json'
        )
        self.assertEqual(clear_pin_save.status_code, 200)
        self.assertFalse(clear_pin_save.json()['isLocked'])
        project.refresh_from_db()
        self.assertIsNone(project.edit_pin)
